
// api/brand-guidelines/approve-text-and-ingest.js
const admin = require('firebase-admin');
const fetch = require('node-fetch');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            type: 'service_account',
            project_id: process.env.FIREBASE_PROJECT_ID,
            private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            client_email: process.env.FIREBASE_CLIENT_EMAIL,
        }),
    });
}

const db = admin.firestore();

/**
 * SEMANTIC CHUNKING STRATEGY (Shared Logic)
 * Ensures consistency between File Uploads and Text/Website Ingestion.
 */
function semanticChunking(text, maxChunkSize = 1000, minChunkSize = 100) {
    // 1. Normalize line endings
    const cleanText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    // 2. Split by logical blocks (Paragraphs)
    const rawParagraphs = cleanText.split(/\n\s*\n/);
    
    const chunks = [];
    let currentChunk = "";
    
    for (const para of rawParagraphs) {
        const cleanPara = para.trim();
        if (!cleanPara) continue;

        const potentialSize = currentChunk.length + cleanPara.length + 2;

        if (potentialSize <= maxChunkSize) {
            currentChunk += (currentChunk ? "\n\n" : "") + cleanPara;
        } else {
            if (currentChunk.length >= minChunkSize) {
                chunks.push(currentChunk);
                currentChunk = "";
            }

            if (cleanPara.length > maxChunkSize) {
                // Split huge paragraph by sentences
                const sentences = cleanPara.match(/[^.!?]+[.!?]+(\s+|$)/g) || [cleanPara];
                let subChunk = "";
                for (const sentence of sentences) {
                    if (subChunk.length + sentence.length <= maxChunkSize) {
                        subChunk += sentence;
                    } else {
                        if (subChunk) chunks.push(subChunk.trim());
                        subChunk = sentence;
                    }
                }
                if (subChunk) currentChunk = subChunk.trim();
            } else {
                currentChunk = cleanPara;
            }
        }
    }

    if (currentChunk) {
        chunks.push(currentChunk);
    }

    return chunks.filter(c => c.length > 20).map((c, index) => ({
        text: c,
        start: index * 100, 
        end: (index * 100) + c.length
    }));
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

        if (!guidelineId) return res.status(400).json({ error: 'guidelineId is required' });

        const guidelineRef = db.collection('brand_guidelines').doc(guidelineId);
        const guidelineSnap = await guidelineRef.get();
        if (!guidelineSnap.exists) return res.status(404).json({ error: 'Guideline not found' });

        const guideline = guidelineSnap.data();
        const text = guideline.guideline_text;
        if (!text) return res.status(400).json({ error: 'No text content' });

        // --- PHASE 1: SEMANTIC CHUNKING ---
        const chunks = semanticChunking(text, 1000, 100);
        const embedUrl = `https://generativelanguage.googleapis.com/v1beta/models/embedding-001:embedContent?key=${apiKey}`;

        // --- EMBEDDING ---
        const embeddingPromises = chunks.map(async (chunk, idx) => {
            try {
                const response = await fetch(embedUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: { parts: [{ text: chunk.text }] } })
                });
                
                if (!response.ok) {
                    console.warn(`Embedding failed for chunk ${idx}: ${response.statusText}`);
                    return { ...chunk, embedding: null, chunk_index: idx };
                }

                const data = await response.json();
                
                return {
                    text: chunk.text,
                    embedding: data.embedding?.values || null,
                    chunk_index: idx,
                };
            } catch (err) { 
                console.error(`Error embedding text chunk ${idx}:`, err);
                return { ...chunk, embedding: null, chunk_index: idx };
            }
        });

        const results = await Promise.all(embeddingPromises);

        // --- FIRESTORE BATCH WRITE ---
        const BATCH_SIZE = 400; 
        let batch = db.batch();
        let opCounter = 0;
        const sourceName = guideline.file_name || 'Direct Text Input';

        for (const chunkData of results) {
            if (!chunkData.embedding) continue;

            const chunkRef = guidelineRef.collection('chunks').doc();
            batch.set(chunkRef, {
                text: chunkData.text,
                embedding: chunkData.embedding,
                chunk_index: chunkData.chunk_index,
                is_master_source: !!guideline.is_primary,
                metadata: {
                    source_file: sourceName,
                    char_count: chunkData.text.length,
                    type: "semantic_block",
                    ingest_mode: "text_direct"
                },
                created_at: admin.firestore.FieldValue.serverTimestamp(),
            });
            opCounter++;

            if (opCounter >= BATCH_SIZE) {
                await batch.commit();
                batch = db.batch();
                opCounter = 0;
            }
        }

        // Final batch update
        batch.update(guidelineRef, {
            status: 'approved',
            chunk_count: results.length,
            processing_method: 'semantic_v2',
            updated_at: admin.firestore.FieldValue.serverTimestamp(),
        });

        await batch.commit();
        res.status(200).json({ success: true, message: `Text processed into ${chunks.length} semantic chunks` });

    } catch (e) {
        console.error("Text Ingest Error:", e);
        res.status(500).json({ error: 'Server error', message: e.message });
    }
};
