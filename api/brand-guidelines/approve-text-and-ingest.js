// api/brand-guidelines/approve-text-and-ingest.js

const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Khởi tạo Firebase Admin (dùng chung với approve-and-ingest.js)
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

// Khởi tạo Gemini AI để embed
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Approve guideline TEXT (không file) và ingest vào RAG:
 * 1. Lấy guideline_text từ Firestore
 * 2. Chunk text
 * 3. Gọi Gemini embedding cho từng chunk
 * 4. Lưu chunks + embeddings vào subcollection "chunks"
 * 5. Update status = 'approved'
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

        // Chỉ xử lý khi có guideline_text (auto-generated)
        const rawText = guideline.guideline_text;
        if (!rawText || typeof rawText !== 'string') {
            return res.status(400).json({
                error: 'Missing guideline_text. This endpoint is for text-based guidelines only.',
            });
        }

        console.log(
            'APPROVE TEXT - guideline:',
            guidelineId,
            'brand_id:',
            guideline.brand_id || guideline.brandid
        );

        // 2. Chunk text
        const text = rawText.trim();
        if (!text) {
            return res.status(400).json({ error: 'guideline_text is empty after trimming' });
        }

        const chunks = chunkText(text, 800, 100);
        console.log(`APPROVE TEXT - Parsed ${chunks.length} chunks from guideline_text`);

        if (!chunks.length) {
            return res.status(400).json({ error: 'No chunks generated from guideline_text' });
        }

        // 3. Generate embeddings cho từng chunk bằng Gemini
        const model = genAI.getGenerativeModel({ model: 'embedding-001' });

        const embeddingPromises = chunks.map(async (chunk, idx) => {
            try {
                const result = await model.embedContent(chunk.text);
                const embedding = result.embedding.values;

                return {
                    chunk_index: idx,
                    text: chunk.text,
                    embedding, // Array of floats
                    char_start: chunk.start,
                    char_end: chunk.end,
                    has_embedding: true,
                };
            } catch (err) {
                console.error(
                    `APPROVE TEXT - Error embedding chunk ${idx}:`,
                    err.message || err
                );
                // Vẫn lưu chunk để Simple RAG có thể dùng
                return {
                    chunk_index: idx,
                    text: chunk.text,
                    embedding: null,
                    char_start: chunk.start,
                    char_end: chunk.end,
                    has_embedding: false,
                };
            }
        });

        const allChunks = await Promise.all(embeddingPromises);
        const chunksWithEmbedding = allChunks.filter((c) => c.has_embedding);

        console.log(
            `APPROVE TEXT - Embedding results: ${chunksWithEmbedding.length}/${allChunks.length} chunks successfully embedded`
        );
        if (chunksWithEmbedding.length < allChunks.length) {
            console.warn(
                `⚠️ APPROVE TEXT - ${allChunks.length - chunksWithEmbedding.length
                } chunks saved WITHOUT embeddings (Simple RAG only)`
            );
        }

        // 4. Lưu chunks vào Firestore subcollection
        const batch = db.batch();

        allChunks.forEach((chunk) => {
            const chunkRef = guidelineRef.collection('chunks').doc();
            batch.set(chunkRef, {
                ...chunk,
                created_at: admin.firestore.FieldValue.serverTimestamp(),
            });
        });

        // 5. Update guideline status + metadata ingest
        batch.update(guidelineRef, {
            status: 'approved',
            ingested_at: admin.firestore.FieldValue.serverTimestamp(),
            updated_at: admin.firestore.FieldValue.serverTimestamp(),
            chunk_count: allChunks.length,
            chunks_with_embedding: chunksWithEmbedding.length,
            chunks_without_embedding: allChunks.length - chunksWithEmbedding.length,
            ingest_source: 'text', // phân biệt với file-based
        });

        await batch.commit();

        return res.status(200).json({
            success: true,
            message: `Ingested ${allChunks.length} text chunks (${chunksWithEmbedding.length} with embeddings, ${allChunks.length - chunksWithEmbedding.length
                } without)`,
            guidelineId,
            chunkCount: allChunks.length,
            chunksWithEmbedding: chunksWithEmbedding.length,
            chunksWithoutEmbedding: allChunks.length - chunksWithEmbedding.length,
        });
    } catch (e) {
        console.error('ERR/brand-guidelines-approve-text-and-ingest:', e);
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
