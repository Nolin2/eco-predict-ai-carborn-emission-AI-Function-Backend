/**
 * Google Cloud Function (GCF) exported as 'runAnalysis_function'.
 * This function serves as the secure backend endpoint for the EcoPredict AI tool.
 *
 * CRITICAL FUNCTIONS:
 * 1. Authentication: Verifies the Firebase ID Token sent from the client.
 * 2. Authorization: Checks the user's subscription status in Firestore (pro/free).
 * 3. AI Analysis: Calls the Gemini API securely using a secret environment variable.
 * 4. Rate Limiting: Decrements the analysis count for 'free' tier users.
 */
import express from 'express';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';

const admin = require('firebase-admin');
const { GoogleGenAI } = require('@google/genai');
const cors = require('cors')({ origin: true });

// Configuration and Initialization
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY environment variable is not set.");
}

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
    admin.initializeApp();
}

const db = admin.firestore();
const ai = new GoogleGenAI(GEMINI_API_KEY);

// Use the K_SERVICE environment variable or fallback to a default
const appId = typeof process.env.K_SERVICE !== 'undefined' ? process.env.K_SERVICE : 'default-app-id';

/**
 * Ensures the user has permission to run the analysis based on their subscription tier
 * and usage limits.
 * @param {string} userId - The Firebase UID of the user.
 * @returns {Promise<{canProceed: boolean, message: string}>}
 */
async function checkSubscription(userId) {
    const userStatusRef = db.doc(`/artifacts/${appId}/users/${userId}/subscriptions/status`);
    const freeTierUsageRef = db.doc(`/artifacts/${appId}/users/${userId}/usage/analysis_count`);
    const FREE_TIER_LIMIT = 5; // Example: Allow 5 analyses per month for the free tier

    try {
        const [statusSnap, usageSnap] = await Promise.all([userStatusRef.get(), freeTierUsageRef.get()]);

        const statusData = statusSnap.data() || { tier: 'free', status: 'unknown' };
        const usageData = usageSnap.data() || { count: 0, last_reset: new Date(0) };
        
        let currentCount = usageData.count;

        // --- Pro Tier Check ---
        if (statusData.tier === 'pro' && statusData.status === 'active') {
            return { canProceed: true, message: 'Pro subscription active.' };
        }

        // --- Free Tier Check ---
        if (currentCount < FREE_TIER_LIMIT) {
            // User can proceed, but we must increment the counter
            const newCount = currentCount + 1;
            
            await freeTierUsageRef.set({
                count: newCount,
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
    const prompt = `Analyze the following operational data for a company to predict its total annual carbon footprint in metric tons of CO2e. Then, provide actionable solutions and explain the problems. The output MUST be a valid JSON object matching the following structure. Do not include any text outside the JSON block.

Operational Data: ${JSON.stringify(analysisData)}

JSON Schema:
{
  "predicted_footprint_tCO2e": 0, // A single numeric value for total CO2e
  "explanation_of_problems": "string", // An explanation of the current high emission areas.
  "solution_plan": [ // An array of actionable steps
    {
      "area": "string", // e.g., Logistics, Energy, Supply Chain
      "action": "string", // e.g., Switch 50% fleet to electric
      "reduction_estimate_tCO2e": 0 // Estimated CO2e reduction (numeric)
    }
  ],
  "breakdown_chart_data": [ // Data for a D3 pie chart
    { "source": "string", "tCO2e": 0 },
    // ... minimum 3 source entries (e.g., Electricity, Travel, Freight)
  ]
}
`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-preview-09-2025',
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: {
                // Force the model to generate a JSON response
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


/**
 * Main HTTP entry point for the Cloud Function.
 */
exports.runAnalysis_function = (req, res) => {
    // Enable CORS for frontend applications
    cors(req, res, async () => {
        
        if (req.method !== 'POST') {
            return res.status(405).send({ error: 'Method Not Allowed. Use POST.' });
        }

        const token = req.headers.authorization ? req.headers.authorization.split('Bearer ')[1] : null;
        const analysisData = req.body.data;
        
        if (!token || !analysisData) {
            return res.status(400).send({ error: 'Missing authorization token or analysis data.' });
        }

        let userId;
        try {
            // --- SECURITY STEP 1: AUTHENTICATE USER ---
            const decodedToken = await admin.auth().verifyIdToken(token);
            userId = decodedToken.uid;
        } catch (error) {
            console.error("Token verification failed:", error.message);
            return res.status(401).send({ error: 'Unauthorized: Invalid authentication token.' });
        }

        // --- SECURITY STEP 2: AUTHORIZE (SUBSCRIPTION CHECK) ---
        const authCheck = await checkSubscription(userId);
        if (!authCheck.canProceed) {
            console.warn(`Access denied for user ${userId}. Reason: ${authCheck.message}`);
            return res.status(403).send({ error: authCheck.message });
        }

        // --- STEP 3: RUN AI ANALYSIS ---
        try {
            const aiResult = await runGeminiAnalysis(analysisData);
            
            // Send the structured AI result back to the frontend
            return res.status(200).send({
                success: true,
                message: authCheck.message, // Passes back the usage count status
                result: aiResult
            });

        } catch (error) {
            console.error("AI Analysis Execution Error:", error.message);
            return res.status(500).send({ error: 'Failed to generate AI analysis.' });
        }
    });
};
