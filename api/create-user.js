import admin from "firebase-admin";
import nodemailer from "nodemailer";
import dotenv from 'dotenv';

dotenv.config();

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

        const { name, email, password, role, ownedBrandIds, assignedBrandIds } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ error: "Missing required fields: name, email, password" });
        }

        // 1. Create User in Firebase Auth
        const newUser = await auth.createUser({
            email,
            password,
            displayName: name,
            emailVerified: false // Set explicitely to false so verify link works
        });

        // 2. Create User Profile in Firestore
        await db.collection("users").doc(newUser.uid).set({
            name,
            email,
            role,
            ownedBrandIds: role === "brand_owner" ? ownedBrandIds || [] : [],
            assignedBrandIds: role === "content_creator" ? assignedBrandIds || [] : [],
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            createdBy: currentUser.uid,
        });

        // 3. Generate Verification Link & Send Email
        let emailStatus = "skipped";
        let verificationLink = null;

        try {
            // Luôn tạo link xác thực dù có SMTP hay không
            verificationLink = await auth.generateEmailVerificationLink(email);
        } catch (linkError) {
            console.error("Error generating verification link:", linkError);
        }

        // Chỉ gửi mail nếu có cấu hình SMTP
        if (process.env.SMTP_USER && process.env.SMTP_PASS && verificationLink) {
            try {
                const transporter = nodemailer.createTransport({
                    service: process.env.SMTP_SERVICE || 'gmail',
                    auth: {
                        user: process.env.SMTP_USER,
                        pass: process.env.SMTP_PASS,
                    },
                });

                await transporter.sendMail({
                    from: `"MOODBIZ Portal System" <${process.env.SMTP_USER}>`,
                    to: email,
                    subject: 'Chào mừng đến với MOODBIZ - Xác thực tài khoản',
                    html: `
                        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 10px;">
                            <h2 style="color: #102d62;">Xin chào ${name},</h2>
                            <p>Tài khoản của bạn đã được khởi tạo trên hệ thống <strong>MOODBIZ Digital Growth Partner</strong>.</p>
                            <p>Vui lòng nhấn vào nút bên dưới để xác thực email và kích hoạt tài khoản:</p>
                            <a href="${verificationLink}" style="display: inline-block; background-color: #01ccff; color: #102d62; font-weight: bold; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin: 20px 0;">Xác thực ngay</a>
                            <p style="font-size: 12px; color: #64748b;">Hoặc copy link này vào trình duyệt: <br/>${verificationLink}</p>
                            <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;">
                            <p style="font-size: 12px; color: #94a3b8;">Email này được gửi tự động. Vui lòng không trả lời.</p>
                        </div>
                    `
                });
                emailStatus = "sent";
            } catch (emailError) {
                console.error("Failed to send verification email:", emailError);
                emailStatus = "failed: " + emailError.message;
            }
        } else {
            console.warn("SMTP credentials missing or link generation failed. Email verification skipped.");
            if (verificationLink) {
                // Log link ra console server để debug
                console.log(">>> MANUAL VERIFICATION LINK:", verificationLink);
            }
        }

        return res.status(200).json({
            success: true,
            message: `Created user ${name} successfully. Email status: ${emailStatus}`,
            userId: newUser.uid,
            verificationLink: verificationLink // Trả về link để admin có thể gửi thủ công nếu cần
        });
    } catch (error) {
        return res.status(500).json({ error: "Server error: " + error.message });
    }
}