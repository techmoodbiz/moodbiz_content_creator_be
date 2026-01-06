
import admin from "firebase-admin";

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

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization");

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

        let { name, email, password, role, ownedBrandIds, assignedBrandIds } = req.body;

        // --- SECURITY CHECK FOR BRAND OWNER ---
        if (currentUserData.role === 'brand_owner') {
            // 1. Enforce Role Limit
            if (role !== 'content_creator') {
                return res.status(403).json({ error: "Brand Owners are strictly limited to creating Content Creator accounts." });
            }

            // 2. Enforce Brand Assignment Limit (CRITICAL FIX)
            // Brand Owner chỉ được gán nhân viên vào các brand mà mình sở hữu (ownedBrandIds)
            const ownerBrands = currentUserData.ownedBrandIds || [];
            
            // Lọc assignedBrandIds đầu vào: chỉ giữ lại những ID nằm trong ownerBrands
            if (Array.isArray(assignedBrandIds)) {
                assignedBrandIds = assignedBrandIds.filter(id => ownerBrands.includes(id));
            } else {
                assignedBrandIds = [];
            }
            
            // Brand Owner không được set ownedBrandIds cho người khác (chỉ Admin mới làm được, hoặc logic tạo BO khác)
            ownedBrandIds = []; 
        }
        // -------------------------------------

        if (!name || !email || !password) {
            return res.status(400).json({ error: "Missing required fields: name, email, password" });
        }

        const newUser = await auth.createUser({
            email,
            password,
            displayName: name,
        });

        await db.collection("users").doc(newUser.uid).set({
            name,
            email,
            role,
            ownedBrandIds: role === "brand_owner" ? ownedBrandIds || [] : [],
            assignedBrandIds: role === "content_creator" ? assignedBrandIds || [] : [],
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            createdBy: currentUser.uid,
        });

        return res.status(200).json({
            success: true,
            message: `Created user ${name} successfully`,
            userId: newUser.uid,
        });
    } catch (error) {
        return res.status(500).json({ error: "Server error: " + error.message });
    }
}
