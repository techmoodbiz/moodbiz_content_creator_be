
// api/brand-guidelines/approve-and-ingest.js
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const mammoth = require('mammoth');
const { GoogleGenAI } = require("@google/genai");

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

function semanticChunking(text, maxChunkSize = 1000, minChunkSize = 100) {
    const cleanText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
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
    if (currentChunk) chunks.push(currentChunk);
    return chunks.filter(c => c.length > 20).map((c, index) => ({
        text: c, start: index * 100, end: (index * 100) + c.length
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

        if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

        const guidelineRef = db.collection('brand_guidelines').doc(guidelineId);
        const guidelineSnap = await guidelineRef.get();
        if (!guidelineSnap.exists) return res.status(404).json({ error: 'Guideline not found' });

        const guideline = guidelineSnap.data();
        const filePath = guideline.storage_path;
        const file = bucket.file(filePath);
        const [fileBuffer] = await file.download();

        let text = '';
        const fileName = (guideline.file_name || '').toLowerCase();

        // --- VISUAL OCR USING GEMINI 3.0 FLASH ---
        if (fileName.endsWith('.pdf')) {
            console.log("Processing PDF with Gemini Vision...");
            const ai = new GoogleGenAI({ apiKey: apiKey });
            const base64Data = fileBuffer.toString('base64');
            
            // Gửi trực tiếp PDF (mimeType application/pdf) cho Gemini 3.0 xử lý
            const response = await ai.models.generateContent({
                model: 'gemini-3-flash-preview',
                contents: [
                    { inlineData: { mimeType: 'application/pdf', data: base64Data } },
                    { text: "Extract ALL text from this document. \n1. Keep the structure (Headers, Lists, Tables) as Markdown. \n2. Do NOT summarize. \n3. If there are visual examples of Do's/Don'ts, describe them." }
                ]
            });
            text = response.text || "";
            
        } else if (fileName.endsWith('.docx') || fileName.endsWith('.doc')) {
            const result = await mammoth.extractRawText({ buffer: fileBuffer });
            text = result.value;
        } else {
            text = fileBuffer.toString('utf-8');
        }

        if (!text || text.trim().length === 0) return res.status(400).json({ error: 'Empty file content' });

        // --- EMBEDDING & SAVING ---
        const chunks = semanticChunking(text, 1000, 100);
        const embedUrl = `https://generativelanguage.googleapis.com/v1beta/models/embedding-001:embedContent?key=${apiKey}`;

        const embeddingPromises = chunks.map(async (chunk, idx) => {
            try {
                const response = await fetch(embedUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: { parts: [{ text: chunk.text }] } })
                });
                const data = await response.json();
                return { ...chunk, embedding: data.embedding?.values || null, chunk_index: idx };
            } catch (err) { return { ...chunk, embedding: null, chunk_index: idx }; }
        });

        const results = await Promise.all(embeddingPromises);
        
        let batch = db.batch();
        let opCounter = 0;
        const BATCH_SIZE = 400;

        for (const chunkData of results) {
            if (!chunkData.embedding) continue; 
            const chunkRef = guidelineRef.collection('chunks').doc();
            batch.set(chunkRef, {
                text: chunkData.text,
                embedding: chunkData.embedding,
                chunk_index: chunkData.chunk_index,
                is_master_source: !!guideline.is_primary,
                metadata: { source_file: guideline.file_name, char_count: chunkData.text.length, type: "semantic_block", extraction_method: "gemini_vision_v3" },
                created_at: admin.firestore.FieldValue.serverTimestamp(),
            });
            opCounter++;
            if (opCounter >= BATCH_SIZE) { await batch.commit(); batch = db.batch(); opCounter = 0; }
        }

        batch.update(guidelineRef, {
            status: 'approved',
            guideline_text: text.substring(0, 50000), 
            chunk_count: results.length,
            processing_method: 'gemini_vision_v3',
            updated_at: admin.firestore.FieldValue.serverTimestamp(),
        });

        await batch.commit();
        res.status(200).json({ success: true, message: `Processed ${chunks.length} chunks via Gemini Vision` });

    } catch (e) {
        console.error("Ingest Error:", e);
        res.status(500).json({ error: 'Server error', message: e.message });
    }
};
