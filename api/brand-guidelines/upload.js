// api/brand-guidelines/upload.js

const fetch = require('node-fetch');
const admin = require('firebase-admin');
const Busboy = require('busboy');

// Khởi tạo Firebase Admin (nếu chưa)
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            type: 'service_account',
            project_id: process.env.FIREBASE_PROJECT_ID,
            private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            client_email: process.env.FIREBASE_CLIENT_EMAIL,
        }),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET, // vd: "moodbiz---rbac.appspot.com"
    });
}

const db = admin.firestore();
const bucket = admin.storage().bucket();

/**
 * Upload guideline file:
 * - Nhận multipart/form-data từ FE
 * - Lưu file vào Firebase Storage: brands/{brandId}/guidelines/{timestamp}-{filename}
 * - Tạo doc trong collection "brand_guidelines"
 */
module.exports = async function handler(req, res) {
    // CORS
    const allowedOrigin = req.headers.origin;
    const whitelist = [
        'https://moodbiz---rbac.web.app',
        'http://localhost:5000',
        'http://localhost:3000',
        'http://127.0.0.1:5500',
        'http://localhost:5500',
    ];

    if (whitelist.includes(allowedOrigin)) {
        // Cho dev: mở * để đỡ dính CORS; khi lên production có thể siết lại
        res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const contentType = req.headers['content-type'] || '';
        if (!contentType.startsWith('multipart/form-data')) {
            return res
                .status(400)
                .json({ error: 'Content-Type must be multipart/form-data' });
        }

        const bb = Busboy({ headers: req.headers });

        // Lưu field text + file buffer
        const fields = {};
        let fileBuffer = null;
        let fileInfo = null;

        // text fields
        bb.on('field', (fieldname, val) => {
            fields[fieldname] = val;
        });

        // file field
        bb.on('file', (fieldname, file, info) => {
            const { filename, mimeType } = info;

            // chỉ nhận field "file"
            if (fieldname !== 'file') {
                file.resume();
                return;
            }

            fileInfo = { filename, mimeType };
            const chunks = [];

            file.on('data', (data) => {
                chunks.push(data);
            });

            file.on('end', () => {
                fileBuffer = Buffer.concat(chunks);
            });
        });

        bb.on('finish', async () => {
            try {
                if (!fileBuffer || !fileInfo) {
                    return res.status(400).json({ error: 'No file uploaded' });
                }

                const brandId = fields.brandId;
                if (!brandId) {
                    return res.status(400).json({ error: 'brandId is required' });
                }

                const uploadPath = `brands/${brandId}/guidelines/${Date.now()}-${fileInfo.filename}`;
                const uploadFile = bucket.file(uploadPath);

                // Lưu file vào Storage
                await uploadFile.save(fileBuffer, {
                    metadata: { contentType: fileInfo.mimeType },
                });

                // Tạo URL public (hoặc signed URL dài hạn)
                const [url] = await uploadFile.getSignedUrl({
                    action: 'read',
                    expires: '2099-12-31',
                });

                const now = admin.firestore.FieldValue.serverTimestamp();

                const docRef = await db.collection('brand_guidelines').add({
                    brand_id: brandId,
                    type: fields.type || 'guideline',
                    description: fields.description || '',
                    file_name: fileInfo.filename,
                    file_url: url,
                    file_type: fileInfo.mimeType || '',
                    status: 'pending',
                    uploaded_by: fields.uploadedBy || null,
                    uploaded_role: fields.uploadedRole || null,
                    created_at: now,
                    updated_at: now,
                    ingested_at: null,
                });

                return res.status(200).json({
                    success: true,
                    id: docRef.id,
                    fileUrl: url,
                });
            } catch (err) {
                console.error('ERR/brand-guidelines-upload finish:', err);
                return res
                    .status(500)
                    .json({ error: 'Server error', message: err.message });
            }
        });

        req.pipe(bb);
    } catch (e) {
        console.error('ERR/brand-guidelines-upload outer:', e);
        return res.status(500).json({ error: 'Server error', message: e.message });
    }
};
