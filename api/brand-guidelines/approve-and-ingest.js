// api/brand-guidelines/approve-and-ingest.js

const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');

// Khởi tạo Firebase Admin
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

// Khởi tạo Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Approve guideline và ingest vào RAG system:
 * 1. Download file từ Storage
 * 2. Parse document (PDF/DOCX)
 * 3. Chunk text thành các đoạn nhỏ
 * 4. Generate embeddings cho mỗi chunk
 * 5. Lưu chunks + embeddings vào Firestore
 * 6. Update status = 'approved'
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
        const { guidelineId } = req.body;

        if (!guidelineId) {
            return res.status(400).json({ error: 'guidelineId is required' });
        }

        // 1. Lấy guideline doc từ Firestore
        const guidelineRef = db.collection('brand_guidelines').doc(guidelineId);
        const guidelineSnap = await guidelineRef.get();

        if (!guidelineSnap.exists) {
            return res.status(404).json({ error: 'Guideline not found' });
        }

        const guideline = guidelineSnap.data();

        // 2. Download file từ Storage
        // Parse file path từ signed URL
        // URL format: https://storage.googleapis.com/.../o/brands%2F...%2Ffile.pdf?...
        // Use storage_path field directly
        const filePath = guideline.storage_path;
        if (!filePath) {
            return res.status(400).json({
                error: 'Missing storage_path. Please re-upload the file with updated backend.'
            });
        }
        console.log('Downloading file from Storage:', filePath);
        const file = bucket.file(filePath);
        const [fileBuffer] = await file.download();

        // 3. Parse document dựa vào file type
        let text = '';
        const fileType = guideline.file_type || '';

        if (fileType.includes('pdf')) {
            // Dùng pdf-parse cho môi trường Node
            const data = await pdfParse(fileBuffer);
            text = data.text || '';
        } else if (
            fileType.includes('word') ||
            fileType.includes('document') ||
            guideline.file_name.endsWith('.docx')
        ) {
            const result = await mammoth.extractRawText({ buffer: fileBuffer });
            text = result.value;
        } else {
            text = fileBuffer.toString('utf-8');
        }


        // 4. Chunk text (split thành các đoạn ~800 chars với overlap)
        const chunks = chunkText(text, 800, 100);

        console.log(`Parsed ${chunks.length} chunks from ${guideline.file_name}`);

        // 5. Generate embeddings cho từng chunk bằng Gemini
        const model = genAI.getGenerativeModel({ model: 'embedding-001' });

        const embeddingPromises = chunks.map(async (chunk, idx) => {
            try {
                const result = await model.embedContent(chunk.text);
                const embedding = result.embedding.values;

                return {
                    chunk_index: idx,
                    text: chunk.text,
                    embedding: embedding, // Array of floats
                    char_start: chunk.start,
                    char_end: chunk.end,
                    has_embedding: true, // Track embedding status
                };
            } catch (err) {
                console.error(`Error embedding chunk ${idx}:`, err.message || err);
                // Still save chunk without embedding for Simple RAG fallback
                return {
                    chunk_index: idx,
                    text: chunk.text,
                    embedding: null, // No embedding available
                    char_start: chunk.start,
                    char_end: chunk.end,
                    has_embedding: false, // Mark as missing embedding
                };
            }
        });

        const allChunks = await Promise.all(embeddingPromises);
        const chunksWithEmbedding = allChunks.filter(c => c.has_embedding);

        console.log(`Embedding results: ${chunksWithEmbedding.length}/${allChunks.length} chunks successfully embedded`);
        if (chunksWithEmbedding.length < allChunks.length) {
            console.warn(`⚠️ ${allChunks.length - chunksWithEmbedding.length} chunks saved WITHOUT embeddings (Simple RAG only)`);
        }

        // 6. Lưu chunks vào Firestore subcollection (cả có và không có embedding)
        const batch = db.batch();

        allChunks.forEach((chunk) => {
            const chunkRef = guidelineRef.collection('chunks').doc();
            batch.set(chunkRef, {
                ...chunk,
                created_at: admin.firestore.FieldValue.serverTimestamp(),
            });
        });

        // 7. Update guideline status
        batch.update(guidelineRef, {
            status: 'approved',
            ingested_at: admin.firestore.FieldValue.serverTimestamp(),
            updated_at: admin.firestore.FieldValue.serverTimestamp(),
            chunk_count: allChunks.length,
            chunks_with_embedding: chunksWithEmbedding.length,
            chunks_without_embedding: allChunks.length - chunksWithEmbedding.length,
        });

        await batch.commit();

        return res.status(200).json({
            success: true,
            message: `Ingested ${allChunks.length} chunks (${chunksWithEmbedding.length} with embeddings, ${allChunks.length - chunksWithEmbedding.length} without)`,
            guidelineId,
            chunkCount: allChunks.length,
            chunksWithEmbedding: chunksWithEmbedding.length,
            chunksWithoutEmbedding: allChunks.length - chunksWithEmbedding.length,
        });
    } catch (e) {
        console.error('ERR/brand-guidelines-approve-and-ingest:', e);
        return res.status(500).json({
            error: 'Server error',
            message: e.message,
        });
    }
};

/**
 * Chunk text thành các đoạn nhỏ với overlap
 * @param {string} text - Text cần chunk
 * @param {number} chunkSize - Kích thước mỗi chunk (chars)
 * @param {number} overlap - Số chars overlap giữa các chunk
 * @returns {Array<{text: string, start: number, end: number}>}
 */
function chunkText(text, chunkSize = 800, overlap = 100) {
    const chunks = [];
    let start = 0;

    while (start < text.length) {
        const end = Math.min(start + chunkSize, text.length);
        const chunkText = text.slice(start, end);

        chunks.push({
            text: chunkText.trim(),
            start,
            end,
        });

        start += chunkSize - overlap;
    }

    return chunks;
}
