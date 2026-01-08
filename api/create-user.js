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
            emailVerified: false // Set explicitly to false so verify link works if needed
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

        // 3. Generate Link & Send Notification Email
        let emailStatus = "init";
        let verificationLink = null;
        let debugInfo = "";

        // Kiểm tra biến môi trường
        const hasSmtpUser = !!process.env.SMTP_USER;
        const hasSmtpPass = !!process.env.SMTP_PASS;
        
        console.log(">>> [CreateUser] SMTP Check:", { 
            hasUser: hasSmtpUser, 
            hasPass: hasSmtpPass,
            userEmail: process.env.SMTP_USER 
        });

        try {
            // Tạo link để người dùng có thể click vào và đăng nhập/xác thực ngay
            verificationLink = await auth.generateEmailVerificationLink(email);
        } catch (linkError) {
            console.error(">>> [CreateUser] Error generating link:", linkError);
            emailStatus = "link_gen_failed";
        }
        
        // Chỉ gửi mail nếu có cấu hình SMTP
        if (hasSmtpUser && hasSmtpPass && verificationLink) {
            try {
                // Cấu hình Transporter
                let transporterConfig = {};
                
                // Ưu tiên dùng service 'gmail' nếu không có HOST cụ thể (dễ cấu hình hơn)
                if (process.env.SMTP_SERVICE === 'gmail' || !process.env.SMTP_HOST) {
                    transporterConfig = {
                        service: 'gmail',
                        auth: {
                            user: process.env.SMTP_USER,
                            pass: process.env.SMTP_PASS, // Phải là App Password nếu dùng Gmail 2FA
                        },
                    };
                } else {
                    // Cấu hình SMTP Custom (dành cho doanh nghiệp)
                    transporterConfig = {
                        host: process.env.SMTP_HOST,
                        port: parseInt(process.env.SMTP_PORT || "587"),
                        secure: process.env.SMTP_SECURE === "true", // true for 465, false for other ports
                        auth: {
                            user: process.env.SMTP_USER,
                            pass: process.env.SMTP_PASS,
                        },
                    };
                }

                const transporter = nodemailer.createTransport(transporterConfig);

                // Verify connection configuration
                try {
                    await transporter.verify();
                    console.log(">>> [CreateUser] SMTP Connection Verified");
                } catch (verifyErr) {
                    throw new Error("SMTP Connection Failed: " + verifyErr.message);
                }

                // Format vai trò hiển thị cho đẹp
                const displayRole = role === 'brand_owner' ? 'Chủ sở hữu thương hiệu (Brand Owner)' : 
                                    role === 'content_creator' ? 'Nhà sáng tạo nội dung (Content Creator)' : 
                                    role === 'admin' ? 'Quản trị viên (Admin)' : 'Thành viên';

                await transporter.sendMail({
                    from: `"MOODBIZ System" <${process.env.SMTP_USER}>`,
                    to: email,
                    subject: 'Thông báo: Tài khoản hệ thống MOODBIZ đã được khởi tạo',
                    html: `
                        <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
                            <div style="background-color: #102d62; padding: 30px 40px; text-align: center;">
                                <h1 style="color: #ffffff; margin: 0; font-size: 24px; text-transform: uppercase; letter-spacing: 2px;">MOODBIZ <span style="color: #01ccff;">PORTAL</span></h1>
                            </div>
                            <div style="padding: 40px;">
                                <h2 style="color: #102d62; margin-top: 0;">Xin chào ${name},</h2>
                                <p style="color: #475569; font-size: 16px; line-height: 1.6;">
                                    Tài khoản của bạn đã được khởi tạo thành công trên hệ thống <strong>MOODBIZ Digital Growth Partner</strong>.
                                </p>
                                
                                <div style="background-color: #f8fafc; border-left: 4px solid #01ccff; padding: 15px 20px; margin: 25px 0; border-radius: 4px;">
                                    <p style="margin: 5px 0; font-size: 14px; color: #64748b;"><strong>Email đăng nhập:</strong> ${email}</p>
                                    <p style="margin: 5px 0; font-size: 14px; color: #64748b;"><strong>Mật khẩu:</strong> (Vui lòng liên hệ Admin để nhận mật khẩu hoặc sử dụng mật khẩu đã được cấp)</p>
                                    <p style="margin: 5px 0; font-size: 14px; color: #64748b;"><strong>Vai trò:</strong> ${displayRole}</p>
                                </div>

                                <p style="color: #475569; font-size: 16px;">Vui lòng nhấn nút bên dưới để kích hoạt tài khoản và truy cập hệ thống:</p>
                                
                                <div style="text-align: center; margin: 35px 0;">
                                    <a href="${verificationLink}" style="display: inline-block; background-color: #102d62; color: #ffffff; font-weight: bold; padding: 14px 32px; text-decoration: none; border-radius: 8px; box-shadow: 0 4px 6px rgba(16, 45, 98, 0.2);">Truy cập hệ thống ngay</a>
                                </div>
                                
                                <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 30px 0;">
                                <p style="font-size: 12px; color: #94a3b8; text-align: center;">Email này được gửi tự động từ hệ thống MOODBIZ. Vui lòng không trả lời.</p>
                            </div>
                        </div>
                    `
                });
                emailStatus = "sent";
            } catch (emailError) {
                console.error(">>> [CreateUser] Failed to send notification email:", emailError);
                emailStatus = "failed: " + emailError.message;
                debugInfo = "Check SMTP config in .env. If using Gmail, use App Password.";
            }
        } else {
            emailStatus = "skipped_missing_config";
            debugInfo = "Missing SMTP_USER or SMTP_PASS in environment variables.";
            console.warn(">>> [CreateUser] SMTP credentials missing. Email skipped.");
            if (verificationLink) {
                console.log(">>> MANUAL LINK (SMTP MISSING):", verificationLink);
            }
        }

        return res.status(200).json({
            success: true,
            message: `Created user ${name} successfully. Email status: ${emailStatus}`,
            userId: newUser.uid,
            verificationLink: verificationLink,
            debug: debugInfo
        });
    } catch (error) {
        return res.status(500).json({ error: "Server error: " + error.message });
    }
}