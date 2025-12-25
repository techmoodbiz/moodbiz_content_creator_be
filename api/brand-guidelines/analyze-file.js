
const busboy = require('busboy');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const fetch = require('node-fetch');

module.exports = async function handler(req, res) {
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
            let text = '';
            const mime = fileInfo.mimeType;
            const filename = (fileInfo.filename || '').toLowerCase();

            if (mime === 'application/pdf' || filename.endsWith('.pdf')) {
                const data = await pdfParse(fileBuffer);
                text = data.text;
            } else if (
                mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
                filename.endsWith('.docx')
            ) {
                const result = await mammoth.extractRawText({ buffer: fileBuffer });
                text = result.value;
            } else {
                // Default text
                text = fileBuffer.toString('utf-8');
            }

            if (!text || text.trim().length < 50) {
                 return res.status(400).json({ error: 'Không tìm thấy đủ nội dung văn bản trong file để phân tích.' });
            }

            // Call Gemini
            const apiKey = process.env.GEMINI_API_KEY;
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`;

            const prompt = `
Analyze the following document content and extract brand guideline information.
Return ONLY a valid JSON object with EXACTLY these camelCase keys:
{
  "brandName": "Company/Brand name",
  "industry": "Industry/Sector",
  "targetAudience": "Target audience description",
  "tone": "Communication tone (formal/casual/friendly/professional)",
  "coreValues": ["Value 1", "Value 2", "Value 3"],
  "keywords": ["keyword1", "keyword2", "keyword3"],
  "visualStyle": "Description of visual style",
  "dos": ["Do this", "Do that"],
  "donts": ["Don't do this", "Don't do that"],
  "summary": "Brief brand summary"
}
Document Content:
${text.substring(0, 30000)}
`;

            const requestBody = {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.7,
                    maxOutputTokens: 8192,
                    responseMimeType: "application/json",
                },
            };

            const aiRes = await fetch(geminiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(requestBody),
            });

            if (!aiRes.ok) {
                 const errText = await aiRes.text();
                 return res.status(500).json({ error: 'Gemini API Error', details: errText });
            }

            const data = await aiRes.json();
            const textResult = data.candidates?.[0]?.content?.parts?.[0]?.text;
            let brandGuideline = JSON.parse(textResult.trim().replace(/```json?/gi, '').replace(/```/g, ''));

            return res.status(200).json({ success: true, data: brandGuideline });

        } catch (e) {
            return res.status(500).json({ error: 'Processing error', message: e.message });
        }
    });

    req.pipe(bb);
};
