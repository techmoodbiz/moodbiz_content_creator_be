// api/create-user.js
const admin = require("firebase-admin");

// Initialize Firebase Admin nếu chưa có
if (!admin.apps.length) {
    try {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            }),
        });
    } catch (error) {
        console.error('Firebase admin initialization error', error);
    }
}

const db = admin.firestore();
const auth = admin.auth();

module.exports = async function handler(req, res) {
    // CORS headers
    const allowedOrigin = req.headers.origin;
    const whitelist = [
        "https://moodbiz---rbac.web.app",
        "http://localhost:5000",
        "http://localhost:3000",
        "http://127.0.0.1:5500" // Thêm cho Live Server
    ];

    if (whitelist.includes(allowedOrigin)) {
        res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    }

    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Max-Age", "86400");

    // Preflight
    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Only POST allowed" });
    }

    try {
        // Lấy token từ header để verify user hiện tại
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const idToken = authHeader.split('Bearer ')[1];

        // Verify token của user hiện tại
        let currentUser;
        try {
            const decodedToken = await auth.verifyIdToken(idToken);
            currentUser = decodedToken;
        } catch (error) {
            return res.status(401).json({ error: "Invalid token" });
        }

        // Kiểm tra quyền: chỉ admin hoặc brand_owner được tạo user
        const currentUserDoc = await db.collection('users').doc(currentUser.uid).get();
        const currentUserData = currentUserDoc.data();

        if (!currentUserData || !['admin', 'brand_owner'].includes(currentUserData.role)) {
            return res.status(403).json({ error: "Permission denied" });
        }

        // Lấy thông tin user mới từ request body
        const { name, email, password, role, ownedBrandId, assignedBrandIds } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ error: "Missing required fields: name, email, password" });
        }

        if (!role || !['admin', 'brand_owner', 'content_creator'].includes(role)) {
            return res.status(400).json({ error: "Invalid role" });
        }

        // Brand Owner chỉ được tạo Content Creator
        if (currentUserData.role === 'brand_owner' && role !== 'content_creator') {
            return res.status(403).json({ error: "Brand Owner can only create Content Creator" });
        }

        // Tạo user mới trong Firebase Auth
        const newUser = await auth.createUser({
            email: email,
            password: password,
            displayName: name,
            emailVerified: false
        });

        // Lưu metadata vào Firestore
        await db.collection('users').doc(newUser.uid).set({
            name: name,
            email: email,
            role: role,
            ownedBrandId: role === 'brand_owner' ? ownedBrandId : null,
            assignedBrandIds: role === 'content_creator' ? (assignedBrandIds || []) : [],
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            createdBy: currentUser.uid
        });

        return res.status(200).json({
            success: true,
            message: `Created user ${name} successfully`,
            userId: newUser.uid,
            user: {
                uid: newUser.uid,
                email: email,
                name: name,
                role: role
            }
        });

    } catch (error) {
        console.error('Error creating user:', error);

        // Handle specific Firebase errors
        if (error.code === 'auth/email-already-exists') {
            return res.status(400).json({ error: "Email already exists" });
        }
        if (error.code === 'auth/invalid-email') {
            return res.status(400).json({ error: "Invalid email format" });
        }
        if (error.code === 'auth/weak-password') {
            return res.status(400).json({ error: "Password too weak (minimum 6 characters)" });
        }

        return res.status(500).json({ error: "Server error: " + error.message });
    }
};
