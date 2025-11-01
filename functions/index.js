/**
 * Express Server for EcoPredict AI Carbon Emission Analysis.
 * This server runs on Render and hosts the API endpoint '/runAnalysis'.
 *
 * It combines the necessary Firebase Admin initialization, authorization logic,
 * and the Gemini AI call into a standard Express architecture.
 */
import express from 'express';
import { GoogleGenAI } from '@google/genai';
// Import 'firebase-admin' as a namespace for ES Modules
import * as admin from 'firebase-admin'; 
import corsModule from 'cors'; 

// --- 1. SETUP & CONFIGURATION ---
const app = express();
// Port is required to be read from the environment in cloud hosting environments
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Use the environment variable K_SERVICE (common in cloud environments) or a fallback
const appId = typeof process.env.K_SERVICE !== 'undefined' ? process.env.K_SERVICE : 'default-app-id';


// Initialization Check
// --- CRITICAL FIX: Use admin.app.getApps() for initialization check in ESM context ---
if (!admin.app.getApps().length) {
    // Note: The service account credentials must be configured via environment variables
    // (e.g., FIREBASE_CREDENTIALS) or deployment secrets in the Render environment.
    admin.initializeApp();
}

const db = admin.firestore();
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });


// --- 2. MIDDLEWARE ---
// Enable CORS for all requests
app.use(corsModule({ origin: true }));
// Parse incoming JSON requests
app.use(express.json()); 


// --- 3. AUTH & AUTHORIZATION LOGIC (Helper Functions) ---

/**
 * Ensures the user has permission to run the analysis based on their subscription tier
 * and usage limits.
 * @param {string} userId - The Firebase UID of the user.
 * @returns {Promise<{canProceed: boolean, message: string}>}
 */
async function checkSubscription(userId) {
    if (!userId) {
        return { canProceed: false, message: 'User ID is required for authorization.' };
    }
    
    // Paths follow the required Canvas/Artifacts structure
    const userStatusRef = db.doc(`/artifacts/${appId}/users/${userId}/subscriptions/status`);
    const freeTierUsageRef = db.doc(`/artifacts/${appId}/users/${userId}/usage/analysis_count`);
    const FREE_TIER_LIMIT = 5;

    try {
        const [statusSnap, usageSnap] = await Promise.all([userStatusRef.get(), freeTierUsageRef.get()]);

        const statusData = statusSnap.data() || { tier: 'free', status: 'unknown' };
        const usageData = usageSnap.data() || { count: 0 };
        
        let currentCount = usageData.count;

        // Pro Tier Check
        if (statusData.tier === 'pro' && statusData.status === 'active') {
            return { canProceed: true, message: 'Pro subscription active.' };
        }

        // Free Tier Check
        if (currentCount < FREE_TIER_LIMIT) {
            const newCount = currentCount + 1;
            
            await freeTierUsageRef.set({
                count: newCount,
                // Access FieldValue correctly via the admin object
                last_use: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });

            return { 
                canProceed: true, 
                message: `Free tier usage: ${newCount}/${FREE_TIER_LIMIT} analyses used.` 
            };
        } else {
            // Usage limit exceeded
            return { 
                canProceed: false, 
                message: `Free tier limit of ${FREE_TIER_LIMIT} analyses exceeded. Please upgrade to Pro.` 
            };
        }

    } catch (error) {
        console.error("Error checking subscription:", error);
        return { canProceed: false, message: 'Internal server error during authorization check.' };
    }
}


/**
 * Calls the Gemini API with the user's operational data.
 * @param {object} analysisData - The user input data from the frontend.
 * @returns {Promise<object>} The parsed JSON response from the AI.
 */
async function runGeminiAnalysis(analysisData) {
    if (!GEMINI_API_KEY) {
        throw new Error("API Key is missing. Cannot perform AI analysis.");
    }
    
    const prompt = `Analyze the following operational data for a company to predict its total annual carbon footprint in metric tons of CO2e. Then, provide actionable solutions and explain the problems. The output MUST be a valid JSON object matching the following structure. Do not include any text outside the JSON block.

Operational Data: ${JSON.stringify(analysisData)}

JSON Schema:
{
  "predicted_footprint_tCO2e": 0,
  "explanation_of_problems": "string",
  "solution_plan": [
    {
      "area": "string",
      "action": "string",
      "reduction_estimate_tCO2e": 0
    }
  ],
  "breakdown_chart_data": [
    { "source": "string", "tCO2e": 0 }
  ]
}
`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-preview-09-2025',
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: {
                responseMimeType: "application/json",
            }
        });
        
        const jsonText = response.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!jsonText) {
            throw new Error("Gemini returned empty response.");
        }

        return JSON.parse(jsonText);
        
    } catch (error) {
        console.error("Gemini API or JSON Parsing Error:", error);
        throw new Error("Could not process analysis via AI. Check API key and model output.");
    }
}


// --- 4. EXPRESS ROUTE HANDLER ---

app.post('/runAnalysis', async (req, res) => {
    
    const token = req.headers.authorization ? req.headers.authorization.split('Bearer ')[1] : null;
    const analysisData = req.body.data;
    
    if (!token || !analysisData) {
        return res.status(400).send({ error: 'Missing authorization token or analysis data.' });
    }

    let userId;
    try {
        // SECURITY STEP 1: AUTHENTICATE USER
        const decodedToken = await admin.auth().verifyIdToken(token);
        userId = decodedToken.uid;
    } catch (error) {
        console.error("Token verification failed:", error.message);
        return res.status(401).send({ error: 'Unauthorized: Invalid authentication token.' });
    }

    // SECURITY STEP 2: AUTHORIZE (SUBSCRIPTION CHECK)
    const authCheck = await checkSubscription(userId);
    if (!authCheck.canProceed) {
        console.warn(`Access denied for user ${userId}. Reason: ${authCheck.message}`);
        return res.status(403).send({ error: authCheck.message });
    }

    // STEP 3: RUN AI ANALYSIS
    try {
        const aiResult = await runGeminiAnalysis(analysisData);
        
        // Send the structured AI result back to the frontend
        return res.status(200).send({
            success: true,
            message: authCheck.message,
            result: aiResult
        });

    } catch (error) {
        console.error("AI Analysis Execution Error:", error.message);
        return res.status(500).send({ error: 'Failed to generate AI analysis.' });
    }
});


// --- 5. START SERVER LISTENER ---

app.listen(PORT, () => {
    console.log(`EcoPredict AI Backend running on port ${PORT}`);
});

// Since this is a standard Express app, we don't need module.exports or exports.
// We keep the export structure for GCF compatibility, but it's not used by Render.
// module.exports = { runAnalysis_function: app };
