// api/create-user.js
const admin = require("firebase-admin");

// ===== INIT FIREBASE ADMIN =====
if (!admin.apps.length) {
    try {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
            }),
        });
    } catch (error) {
        console.error("Firebase admin initialization error", error);
    }
}

const db = admin.firestore();
const auth = admin.auth();

// ===== HANDLER =====
module.exports = async function handler(req, res) {
    // ===== CORS =====
    const origin = req.headers.origin;
    const allowedOrigins = [
        "https://moodbiz---rbac.web.app",
        "http://localhost:3000",
        "http://localhost:5000",
        "http://127.0.0.1:5500",
    ];

    if (allowedOrigins.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization"
    );
    res.setHeader("Access-Control-Max-Age", "86400");

    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Only POST allowed" });
    }

    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const idToken = authHeader.split("Bearer ")[1];

        let currentUser;
        try {
            const decodedToken = await auth.verifyIdToken(idToken);
            currentUser = decodedToken;
        } catch (error) {
            return res.status(401).json({ error: "Invalid token" });
        }

        const currentUserDoc = await db.collection("users").doc(currentUser.uid).get();
        const currentUserData = currentUserDoc.data();

        if (!currentUserData || !["admin", "brand_owner"].includes(currentUserData.role)) {
            return res.status(403).json({ error: "Permission denied" });
        }

        const { name, email, password, role, ownedBrandId, assignedBrandIds } = req.body;

        if (!name || !email || !password) {
            return res
                .status(400)
                .json({ error: "Missing required fields: name, email, password" });
        }

        if (!role || !["admin", "brand_owner", "content_creator"].includes(role)) {
            return res.status(400).json({ error: "Invalid role" });
        }

        if (currentUserData.role === "brand_owner" && role !== "content_creator") {
            return res
                .status(403)
                .json({ error: "Brand Owner can only create Content Creator" });
        }

        const newUser = await auth.createUser({
            email,
            password,
            displayName: name,
            emailVerified: false,
        });

        await db.collection("users").doc(newUser.uid).set({
            name,
            email,
            role,
            ownedBrandId: role === "brand_owner" ? ownedBrandId : null,
            assignedBrandIds: role === "content_creator" ? assignedBrandIds || [] : [],
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            createdBy: currentUser.uid,
        });

        return res.status(200).json({
            success: true,
            message: `Created user ${name} successfully`,
            userId: newUser.uid,
            user: { uid: newUser.uid, email, name, role },
        });
    } catch (error) {
        console.error("Error creating user:", error);

        if (error.code === "auth/email-already-exists") {
            return res.status(400).json({ error: "Email already exists" });
        }
        if (error.code === "auth/invalid-email") {
            return res.status(400).json({ error: "Invalid email format" });
        }
        if (error.code === "auth/weak-password") {
            return res
                .status(400)
                .json({ error: "Password too weak (minimum 6 characters)" });
        }

        return res.status(500).json({ error: "Server error: " + error.message });
    }
};
