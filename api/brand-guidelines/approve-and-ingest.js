
// api/brand-guidelines/approve-and-ingest.js
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');

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

function chunkText(text, chunkSize = 1000, overlap = 150) {
    const chunks = [];
    let start = 0;
    while (start < text.length) {
        const end = Math.min(start + chunkSize, text.length);
        chunks.push({ text: text.slice(start, end).trim(), start, end });
        start += chunkSize - overlap;
    }
    return chunks;
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { guidelineId } = req.body;
        const apiKey = process.env.GEMINI_API_KEY;

        const guidelineRef = db.collection('brand_guidelines').doc(guidelineId);
        const guidelineSnap = await guidelineRef.get();
        if (!guidelineSnap.exists) return res.status(404).json({ error: 'Guideline not found' });

        const guideline = guidelineSnap.data();
        const filePath = guideline.storage_path;
        if (!filePath) return res.status(400).json({ error: 'Missing storage_path' });

        const file = bucket.file(filePath);
        const [fileBuffer] = await file.download();

        let text = '';
        const fileType = guideline.file_type || '';
        if (fileType.includes('pdf')) {
            const data = await pdfParse(fileBuffer);
            text = data.text || '';
        } else if (fileType.includes('word') || guideline.file_name.endsWith('.docx')) {
            const result = await mammoth.extractRawText({ buffer: fileBuffer });
            text = result.value;
        } else {
            text = fileBuffer.toString('utf-8');
        }

        const chunks = chunkText(text);
        const embedUrl = `https://generativelanguage.googleapis.com/v1beta/models/embedding-001:embedContent?key=${apiKey}`;

        const batch = db.batch();
        const embeddingPromises = chunks.map(async (chunk, idx) => {
            try {
                const response = await fetch(embedUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: { parts: [{ text: chunk.text }] } })
                });
                const data = await response.json();
                
                const chunkRef = guidelineRef.collection('chunks').doc();
                batch.set(chunkRef, {
                    text: chunk.text,
                    embedding: data.embedding?.values || null,
                    chunk_index: idx,
                    is_master_source: !!guideline.is_primary,
                    created_at: admin.firestore.FieldValue.serverTimestamp(),
                });
            } catch (err) { 
                const chunkRef = guidelineRef.collection('chunks').doc();
                batch.set(chunkRef, {
                    text: chunk.text,
                    embedding: null,
                    chunk_index: idx,
                    is_master_source: !!guideline.is_primary,
                    created_at: admin.firestore.FieldValue.serverTimestamp(),
                });
            }
        });

        await Promise.all(embeddingPromises);
        batch.update(guidelineRef, {
            status: 'approved',
            guideline_text: text.substring(0, 10000), 
            updated_at: admin.firestore.FieldValue.serverTimestamp(),
        });

        await batch.commit();
        res.status(200).json({ success: true, message: `File processed into ${chunks.length} chunks` });

    } catch (e) {
        res.status(500).json({ error: 'Server error', message: e.message });
    }
};
