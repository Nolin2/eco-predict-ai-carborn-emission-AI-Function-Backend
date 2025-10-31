/**
 * Google Cloud Function (GCF) to handle incoming webhooks from PayPal.
 * This function is critical for monetization: it listens for successful payments,
 * validates the event, and updates the user's subscription status in Firestore
 * from 'free' to 'pro' or vice versa.
 *
 * This function must be deployed with its own public HTTPS endpoint, 
 * which you then configure in your PayPal Developer account as the webhook URL.
 */

const admin = require('firebase-admin');
const cors = require('cors')({ origin: true }); 

// Initialize Firebase Admin SDK
// This is typically handled by the GCF environment, but we ensure it's initialized.
if (!admin.apps.length) {
    admin.initializeApp();
}

const db = admin.firestore();
// Use the K_SERVICE environment variable or fallback to a default
const appId = typeof process.env.K_SERVICE !== 'undefined' ? process.env.K_SERVICE : 'default-app-id';

/**
 * Main function exported for Google Cloud Functions.
 * @param {object} req - HTTP request object containing PayPal event data.
 * @param {object} res - HTTP response object.
 */
exports.paypalWebhookHandler = (req, res) => {
    // The PayPal webhook request should always be a POST.
    if (req.method !== 'POST') {
        return res.status(405).send('Method Not Allowed');
    }

    // Since this is a webhook, we don't typically need CORS, but we include it for robust GCF usage.
    cors(req, res, async () => {
        const data = req.body;

        // --- SECURITY STEP 1: VALIDATE PAYPAL WEBHOOK (MOCK) ---
        // CRITICAL: In a production environment, you MUST use the PayPal SDK 
        // and your secret key (stored in environment variables) to verify the signature 
        // of this webhook. This mock assumes the webhook is valid for simplicity.
        if (!data.event_type) {
            console.error("Invalid PayPal webhook structure: Missing event_type");
            return res.status(400).send('Invalid webhook structure');
        }

        const eventType = data.event_type;
        const resource = data.resource;
        let userId = null;

        // --- STEP 2: EXTRACT USER ID AND EVENT DETAILS ---

        // Extract the Firebase UID, which should have been passed as 'custom_id' during checkout
        if (resource && resource.subscriber && resource.subscriber.custom_id) {
            userId = resource.subscriber.custom_id;
        } else if (resource && resource.custom_id) {
            userId = resource.custom_id;
        }

        if (!userId) {
            console.error(`Could not extract Firebase UID from PayPal payload for event: ${eventType}`);
            return res.status(400).send('Missing user ID in payload');
        }
        
        // The path to the user's subscription status document in Firestore
        const userSubscriptionRef = db.doc(`/artifacts/${appId}/users/${userId}/subscriptions/status`);
        
        console.log(`Processing PayPal event: ${eventType} for User ID: ${userId}`);

        // --- STEP 3: HANDLE KEY SUBSCRIPTION EVENTS ---

        try {
            if (eventType === 'BILLING.SUBSCRIPTION.ACTIVATED') {
                // Subscription successfully paid for and activated
                await userSubscriptionRef.set({
                    tier: 'pro',
                    status: 'active',
                    paypal_id: resource.id,
                    expires_at: admin.firestore.FieldValue.serverTimestamp(), // You would calculate this based on PayPal's data
                    updated_at: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
                console.log(`User ${userId} successfully upgraded to PRO.`);
            
            } else if (eventType === 'BILLING.SUBSCRIPTION.CANCELLED' || eventType === 'BILLING.SUBSCRIPTION.EXPIRED') {
                // Subscription cancelled or expired, downgrade to free tier
                await userSubscriptionRef.set({
                    tier: 'free',
                    status: eventType.toLowerCase(),
                    updated_at: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
                console.log(`User ${userId} downgraded to FREE due to ${eventType}.`);

            } else {
                // Acknowledge other events (e.g., payment success)
                console.log(`Received acknowledged event: ${eventType}. No tier change required.`);
            }

            // --- STEP 4: SEND SUCCESS RESPONSE ---
            // PayPal requires a 200/204 response to acknowledge receipt.
            res.status(204).send(); 
            
        } catch (error) {
            console.error(`Firestore update error for user ${userId}:`, error);
            // Must return a non-2xx status code if processing failed to signal PayPal to retry.
            res.status(500).send('Database Update Failed');
        }
    });
};
