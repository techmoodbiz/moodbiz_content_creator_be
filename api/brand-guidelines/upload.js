
// api/brand-guidelines/upload.js
const admin = require('firebase-admin');
const busboy = require('busboy');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            type: 'service_account',
            project_id: process.env.FIREBASE_PROJECT_ID,
            private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            client_email: process.env.FIREBASE_CLIENT_EMAIL,
        }),
        storageBucket: process.env.GOOGLE_STORAGE_BUCKET,
    });
}

const db = admin.firestore();
const bucket = admin.storage().bucket();

module.exports = async function handler(req, res) {
    const allowedOrigin = req.headers.origin;
    const whitelist = [
        "https://moodbiz---rbac.web.app",
        "http://localhost:5000",
        "http://localhost:3000",
        "http://127.0.0.1:5500",
        "https://brandchecker.moodbiz.agency"
    ];
    if (whitelist.includes(allowedOrigin)) res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const contentType = req.headers['content-type'] || '';
        if (!contentType.startsWith('multipart/form-data')) {
            return res.status(400).json({ error: 'Content-Type must be multipart/form-data' });
        }

        const bb = busboy({ headers: req.headers });
        const fields = {};
        let fileBuffer = null;
        let fileInfo = null;

        bb.on('field', (fieldname, val) => { fields[fieldname] = val; });
        bb.on('file', (fieldname, file, info) => {
            if (fieldname !== 'file') { file.resume(); return; }
            fileInfo = { filename: info.filename, mimeType: info.mimeType };
            const chunks = [];
            file.on('data', (data) => chunks.push(data));
            file.on('end', () => { fileBuffer = Buffer.concat(chunks); });
        });

        bb.on('finish', async () => {
            try {
                if (!fileBuffer || !fileInfo) return res.status(400).json({ error: 'No file uploaded' });
                const brandId = fields.brandId;
                if (!brandId) return res.status(400).json({ error: 'brandId is required' });

                const timestamp = Date.now();
                const uploadPath = `brands/${brandId}/guidelines/${timestamp}-${fileInfo.filename}`;
                const uploadFile = bucket.file(uploadPath);

                await uploadFile.save(fileBuffer, { metadata: { contentType: fileInfo.mimeType } });
                const [url] = await uploadFile.getSignedUrl({ action: 'read', expires: '2099-12-31' });

                // STRUCTURED ID: GUIDE_[BRAND_ID]_[TIMESTAMP]
                const guideId = `GUIDE_${brandId}_${timestamp}`;
                const now = admin.firestore.FieldValue.serverTimestamp();

                await db.collection('brand_guidelines').doc(guideId).set({
                    id: guideId,
                    brand_id: brandId,
                    type: fields.type || 'guideline',
                    description: fields.description || '',
                    file_name: fileInfo.filename,
                    file_url: url,
                    file_type: fileInfo.mimeType || '',
                    storage_path: uploadPath,
                    status: 'pending',
                    is_primary: false, // Default not primary
                    uploaded_by: fields.uploadedBy || null,
                    uploaded_role: fields.uploadedRole || null,
                    created_at: now,
                    updated_at: now,
                });

                return res.status(200).json({ success: true, id: guideId, fileUrl: url });
            } catch (err) {
                return res.status(500).json({ error: 'Server error', message: err.message });
            }
        });
        req.pipe(bb);
    } catch (e) {
        return res.status(500).json({ error: 'Server error', message: e.message });
    }
};
