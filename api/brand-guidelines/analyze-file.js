
import busboy from 'busboy';
import mammoth from 'mammoth';
import { GoogleGenAI } from "@google/genai";

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const bb = busboy({ headers: req.headers });
    let fileBuffer = null;
    let fileInfo = null;

    bb.on('file', (fieldname, file, info) => {
        if (fieldname !== 'file') { file.resume(); return; }
        fileInfo = info;
        const chunks = [];
        file.on('data', (data) => chunks.push(data));
        file.on('end', () => { fileBuffer = Buffer.concat(chunks); });
    });

    bb.on('finish', async () => {
        if (!fileBuffer) return res.status(400).json({ error: 'No file uploaded' });

        try {
            const apiKey = process.env.GEMINI_API_KEY;
            const mime = fileInfo.mimeType;
            const filename = (fileInfo.filename || '').toLowerCase();
            const ai = new GoogleGenAI({ apiKey: apiKey });

            let textContent = '';
            let prompt = `
Analyze the following document (Brand Guideline or Company Profile) and extract key strategic information.

INSTRUCTIONS:
- Identify the Brand Name, Industry, and Target Audience.
- Determine the Tone of Voice (e.g., Professional, Playful, Authoritative).
- Extract Core Values and USP.
- If explicit "Don'ts" are missing, INFER them based on the style.
- Summarize Visual Style (colors, vibe) if visible or described.
`;

            // --- STRATEGY: DOCX uses Mammoth, PDF/Image uses Gemini Vision ---
            
            if (filename.endsWith('.docx') || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
                // Word Documents: Extract text first
                const result = await mammoth.extractRawText({ buffer: fileBuffer });
                textContent = result.value;
                prompt += `\n\nDOCUMENT CONTENT:\n${textContent.substring(0, 50000)}`;
                
                // Call Gemini with Text
                const response = await ai.models.generateContent({
                    model: 'gemini-3-flash-preview',
                    contents: [{ text: prompt }],
                    config: {
                        responseMimeType: "application/json",
                        responseSchema: getResponseSchema()
                    }
                });
                
                return sendResponse(res, response);

            } else {
                // PDF or Images: Use Gemini Vision (Multimodal) directly
                // This replaces pdf-parse and works for Images too
                const base64Data = fileBuffer.toString('base64');
                let aiMimeType = mime;
                
                // Fallback mime types if generic
                if (filename.endsWith('.pdf')) aiMimeType = 'application/pdf';
                else if (filename.endsWith('.png')) aiMimeType = 'image/png';
                else if (filename.endsWith('.jpg') || filename.endsWith('.jpeg')) aiMimeType = 'image/jpeg';

                const response = await ai.models.generateContent({
                    model: 'gemini-3-flash-preview',
                    contents: [
                        { inlineData: { mimeType: aiMimeType, data: base64Data } },
                        { text: prompt }
                    ],
                    config: {
                        responseMimeType: "application/json",
                        responseSchema: getResponseSchema()
                    }
                });

                return sendResponse(res, response);
            }

        } catch (e) {
            console.error("Analyze File Error", e);
            return res.status(500).json({ error: 'Processing error', message: e.message });
        }
    });

    req.pipe(bb);
}

function getResponseSchema() {
    // Define strict schema types from @google/genai
    // Note: In raw JSON request this is just an object, but using the SDK types is cleaner if imported.
    // Here we construct the raw object expected by the SDK.
    return {
        type: "OBJECT",
        properties: {
            brandName: { type: "STRING" },
            industry: { type: "STRING" },
            targetAudience: { type: "STRING" },
            tone: { type: "STRING" },
            coreValues: { type: "ARRAY", items: { type: "STRING" } },
            keywords: { type: "ARRAY", items: { type: "STRING" } }, // Used for USP
            visualStyle: { type: "STRING" },
            dos: { type: "ARRAY", items: { type: "STRING" } },
            donts: { type: "ARRAY", items: { type: "STRING" } },
            summary: { type: "STRING" }
        },
        required: ["brandName", "tone", "dos", "donts", "summary"]
    };
}

function sendResponse(res, aiResponse) {
    try {
        const text = aiResponse.text || "{}";
        const json = JSON.parse(text);
        return res.status(200).json({ success: true, data: json });
    } catch (e) {
        return res.status(500).json({ error: "Failed to parse AI response", details: e.message });
    }
}
