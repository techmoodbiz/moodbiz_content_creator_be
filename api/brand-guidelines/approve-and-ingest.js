
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

/**
 * SEMANTIC CHUNKING STRATEGY (KnowNote Style)
 * Instead of cutting at fixed characters, we split by logical blocks (Paragraphs).
 * 1. Split by double newlines (\n\n) to identify paragraphs.
 * 2. If a paragraph is huge, split it by sentences.
 * 3. Group small paragraphs together to form a meaningful "Atomic Chunk" (~1000 chars).
 */
function semanticChunking(text, maxChunkSize = 1000, minChunkSize = 100) {
    // 1. Normalize line endings and remove excessive whitespace
    const cleanText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    // 2. Split into logical blocks (Paragraphs)
    // We look for double newlines or single newlines followed by a capital letter or bullet point
    const rawParagraphs = cleanText.split(/\n\s*\n/);
    
    const chunks = [];
    let currentChunk = "";
    
    for (const para of rawParagraphs) {
        const cleanPara = para.trim();
        if (!cleanPara) continue;

        // 3. Logic: Accumulate paragraphs until we hit the limit
        const potentialSize = currentChunk.length + cleanPara.length + 2; // +2 for newline

        if (potentialSize <= maxChunkSize) {
            // Fits in current chunk
            currentChunk += (currentChunk ? "\n\n" : "") + cleanPara;
        } else {
            // Overflow: Push current chunk if it exists
            if (currentChunk.length >= minChunkSize) {
                chunks.push(currentChunk);
                currentChunk = "";
            }

            // Handle the new paragraph
            if (cleanPara.length > maxChunkSize) {
                // EDGE CASE: The single paragraph is larger than the limit.
                // We must split this paragraph by sentences to avoid cutting words.
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
                if (subChunk) currentChunk = subChunk.trim(); // Start new accumulator with remainder
            } else {
                // Paragraph fits in a new chunk
                currentChunk = cleanPara;
            }
        }
    }

    // Push the final remnant
    if (currentChunk) {
        chunks.push(currentChunk);
    }

    // Post-processing: Filter out very small noise chunks (e.g., page numbers)
    return chunks.filter(c => c.length > 20).map((c, index) => ({
        text: c,
        start: index * 100, // Approximate, mostly for ordering
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

        const guidelineRef = db.collection('brand_guidelines').doc(guidelineId);
        const guidelineSnap = await guidelineRef.get();
        if (!guidelineSnap.exists) return res.status(404).json({ error: 'Guideline not found' });

        const guideline = guidelineSnap.data();
        const filePath = guideline.storage_path;
        if (!filePath) return res.status(400).json({ error: 'Missing storage_path' });

        const file = bucket.file(filePath);
        const [fileBuffer] = await file.download();

        let text = '';
        const fileName = (guideline.file_name || '').toLowerCase();

        // --- EXTRACT TEXT ---
        if (fileName.endsWith('.pdf')) {
            const data = await pdfParse(fileBuffer);
            text = data.text || '';
        } else if (fileName.endsWith('.docx') || fileName.endsWith('.doc')) {
            const result = await mammoth.extractRawText({ buffer: fileBuffer });
            text = result.value;
        } else {
            text = fileBuffer.toString('utf-8');
        }

        if (!text || text.trim().length === 0) {
            return res.status(400).json({ error: 'Không thể trích xuất nội dung văn bản từ file này.' });
        }

        // --- PHASE 1: SEMANTIC CHUNKING ---
        const chunks = semanticChunking(text, 1000, 100);
        
        const embedUrl = `https://generativelanguage.googleapis.com/v1beta/models/embedding-001:embedContent?key=${apiKey}`;

        // --- EMBEDDING ---
        // We process sequentially or in small batches to respect rate limits if necessary, 
        // but Promise.all is usually fine for < 100 chunks.
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
                console.error(`Error embedding chunk ${idx}:`, err);
                return { ...chunk, embedding: null, chunk_index: idx };
            }
        });

        const results = await Promise.all(embeddingPromises);

        // --- FIRESTORE BATCH WRITE ---
        const BATCH_SIZE = 400; 
        let batch = db.batch();
        let opCounter = 0;

        for (const chunkData of results) {
            if (!chunkData.embedding) continue; // Skip failed embeddings

            const chunkRef = guidelineRef.collection('chunks').doc();
            batch.set(chunkRef, {
                text: chunkData.text,
                embedding: chunkData.embedding,
                chunk_index: chunkData.chunk_index,
                is_master_source: !!guideline.is_primary,
                metadata: {
                    source_file: guideline.file_name,
                    char_count: chunkData.text.length,
                    type: "semantic_block"
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

        // Final batch update for status
        batch.update(guidelineRef, {
            status: 'approved',
            guideline_text: text.substring(0, 50000), // Store raw text for quick preview
            chunk_count: results.length,
            processing_method: 'semantic_v2',
            updated_at: admin.firestore.FieldValue.serverTimestamp(),
        });

        await batch.commit();

        res.status(200).json({ 
            success: true, 
            message: `File processed into ${chunks.length} semantic chunks` 
        });

    } catch (e) {
        console.error("Ingest Error:", e);
        res.status(500).json({ error: 'Server error', message: e.message });
    }
};
