import admin from "firebase-admin";
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

// Khởi tạo Firebase Admin
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
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader(
        "Access-Control-Allow-Headers",
        "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization"
    );

    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Only POST allowed" });
    }

    try {
        // --- AUTH: chỉ admin / brand_owner mới được tạo user ---
        const authHeader = req.headers.authorization || "";
        if (!authHeader.startsWith("Bearer ")) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const idToken = authHeader.split("Bearer ")[1].trim();
        if (!idToken) {
            return res.status(401).json({ error: "Unauthorized" });
        }

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

        // --- INPUT ---
        const { name, email, password, role, ownedBrandIds, assignedBrandIds } = req.body;

        if (!name || !email || !password) {
            return res
                .status(400)
                .json({ error: "Missing required fields: name, email, password" });
        }

        // 1. Tạo user trong Firebase Auth
        const newUser = await auth.createUser({
            email,
            password,
            displayName: name,
            emailVerified: false,
        });

        // 2. Lưu profile trong Firestore
        await db.collection("users").doc(newUser.uid).set({
            name,
            email,
            role,
            ownedBrandIds: role === "brand_owner" ? ownedBrandIds || [] : [],
            assignedBrandIds: role === "content_creator" ? assignedBrandIds || [] : [],
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            createdBy: currentUser.uid,
        });

        // 3. Tạo link xác thực & gửi email
        let emailStatus = "skipped";
        let verificationLink = null;

        try {
            verificationLink = await auth.generateEmailVerificationLink(email);
        } catch (linkError) {
            console.error("Error generating verification link:", linkError);
        }

        // Gửi mail chỉ khi có SMTP + link
        if (
            process.env.SMTP_HOST &&
            process.env.SMTP_PORT &&
            process.env.SMTP_USER &&
            process.env.SMTP_PASS &&
            verificationLink
        ) {
            try {
                const transporter = nodemailer.createTransport({
                    host: process.env.SMTP_HOST,
                    port: Number(process.env.SMTP_PORT) || 587,
                    secure: Number(process.env.SMTP_PORT) === 465, // true nếu dùng 465 (SSL)
                    auth: {
                        user: process.env.SMTP_USER,
                        pass: process.env.SMTP_PASS,
                    },
                });

                // (Có thể bật log debug khi cần)
                // console.log("SMTP config:", {
                //   host: process.env.SMTP_HOST,
                //   port: process.env.SMTP_PORT,
                //   user: process.env.SMTP_USER ? "OK" : "MISSING",
                // });

                const displayRole =
                    role === "brand_owner"
                        ? "Chủ sở hữu thương hiệu (Brand Owner)"
                        : role === "content_creator"
                            ? "Nhà sáng tạo nội dung (Content Creator)"
                            : role === "admin"
                                ? "Quản trị viên (Admin)"
                                : "Thành viên";

                await transporter.sendMail({
                    from: `"MOODBIZ System" <${process.env.SMTP_USER}>`,
                    to: email,
                    subject: "Thông báo: Tài khoản hệ thống MOODBIZ đã được khởi tạo",
                    html: `
            <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
              <div style="background-color: #102d62; padding: 30px 40px; text-align: center;">
                <h1 style="color: #ffffff; margin: 0; font-size: 24px; text-transform: uppercase; letter-spacing: 2px;">
                  MOODBIZ <span style="color: #01ccff;">PORTAL</span>
                </h1>
              </div>
              <div style="padding: 40px;">
                <h2 style="color: #102d62; margin-top: 0;">Xin chào ${name},</h2>
                <p style="color: #475569; font-size: 16px; line-height: 1.6;">
                  Tài khoản của bạn đã được khởi tạo thành công trên hệ thống
                  <strong>MOODBIZ Digital Growth Partner</strong>.
                </p>

                <div style="background-color: #f8fafc; border-left: 4px solid #01ccff; padding: 15px 20px; margin: 25px 0; border-radius: 4px;">
                  <p style="margin: 5px 0; font-size: 14px; color: #64748b;">
                    <strong>Email đăng nhập:</strong> ${email}
                  </p>
                  <p style="margin: 5px 0; font-size: 14px; color: #64748b;">
                    <strong>Mật khẩu:</strong> (Vui lòng liên hệ Admin để nhận mật khẩu hoặc sử dụng mật khẩu đã được cấp)
                  </p>
                  <p style="margin: 5px 0; font-size: 14px; color: #64748b;">
                    <strong>Vai trò:</strong> ${displayRole}
                  </p>
                </div>

                <p style="color: #475569; font-size: 16px;">
                  Vui lòng nhấn nút bên dưới để kích hoạt tài khoản và truy cập hệ thống:
                </p>

                <div style="text-align: center; margin: 35px 0;">
                  <a href="${verificationLink}"
                     style="display: inline-block; background-color: #102d62; color: #ffffff; font-weight: bold; padding: 14px 32px; text-decoration: none; border-radius: 8px; box-shadow: 0 4px 6px rgba(16, 45, 98, 0.2);">
                    Truy cập hệ thống ngay
                  </a>
                </div>

                <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 30px 0;">
                <p style="font-size: 12px; color: #94a3b8; text-align: center;">
                  Email này được gửi tự động từ hệ thống MOODBIZ. Vui lòng không trả lời.
                </p>
              </div>
            </div>
          `,
                });

                emailStatus = "sent";
            } catch (emailError) {
                console.error("Failed to send notification email:", emailError);
                emailStatus = "failed: " + emailError.message;
            }
        } else {
            console.warn(
                "SMTP credentials missing or link generation failed. Email verification skipped."
            );
            if (verificationLink) {
                console.log(">>> MANUAL LINK (SMTP MISSING):", verificationLink);
            }
        }

        return res.status(200).json({
            success: true,
            message: `Created user ${name} successfully. Email status: ${emailStatus}`,
            userId: newUser.uid,
            verificationLink, // có thể bỏ trong production nếu không muốn lộ
        });
    } catch (error) {
        console.error("Create user API error:", error);
        return res.status(500).json({ error: "Server error: " + error.message });
    }
}
