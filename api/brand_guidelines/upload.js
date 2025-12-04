// api/brand-guidelines-upload.js

const fetch = require('node-fetch');
const admin = require('firebase-admin');
const Busboy = require('busboy');

// Khởi tạo Firebase Admin (nếu chưa)
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET, // vd: "moodbiz---rbac.firebasestorage.app"
    });
}

const db = admin.firestore();
const bucket = admin.storage().bucket();

module.exports = async function handler(req, res) {
    // CORS – giống audit.js
    const allowedOrigin = req.headers.origin;
    const whitelist = [
        'https://moodbiz---rbac.web.app',
        'http://localhost:5000',
        'http://localhost:3000',
        'http://127.0.0.1:5500',
    ];

    if (whitelist.includes(allowedOrigin)) {
        res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Max-Age', '86400');
    }

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const contentType = req.headers['content-type'] || '';
        if (!contentType.startsWith('multipart/form-data')) {
            return res.status(400).json({ error: 'Content-Type must be multipart/form-data' });
        }

        const busboy = new Busboy({ headers: req.headers });

        let uploadFile = null;
        const fields = {};

        // Lấy field text (brandId, type, description, uploadedBy, uploadedRole)
        busboy.on('field', (fieldname, val) => {
            fields[fieldname] = val;
        });

        // Lấy file
        busboy.on('file', (fieldname, file, filename, encoding, mimetype) => {
            if (fieldname !== 'file') {
                file.resume();
                return;
            }

            const brandId = fields.brandId;
            if (!brandId) {
                file.resume();
                return;
            }

            const uploadPath = `brands/${brandId}/guidelines/${Date.now()}-${filename}`;
            uploadFile = bucket.file(uploadPath);

            const stream = uploadFile.createWriteStream({
                metadata: { contentType: mimetype },
            });

            file.pipe(stream);

            stream.on('error', (err) => {
                console.error('Upload error:', err);
            });
        });

        busboy.on('finish', async () => {
            if (!uploadFile) {
                return res.status(400).json({ error: 'No file uploaded' });
            }

            // Tạo URL public (tạm: dùng getSignedUrl hoặc cấu hình public bucket)
            const [url] = await uploadFile.getSignedUrl({
                action: 'read',
                expires: '2099-12-31',
            });

            const now = admin.firestore.FieldValue.serverTimestamp();

            const docRef = await db.collection('brand_guidelines').add({
                brand_id: fields.brandId,
                type: fields.type || 'guideline',
                description: fields.description || '',
                file_name: uploadFile.name.split('/').pop(),
                file_url: url,
                file_type: uploadFile.metadata?.contentType || '',
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
        });

        req.pipe(busboy);
    } catch (e) {
        console.error('ERR/brand-guidelines-upload:', e);
        return res.status(500).json({ error: 'Server error', message: e.message });
    }
};
