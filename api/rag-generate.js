
// api/rag-generate.js
const fetch = require("node-fetch");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      type: "service_account",
      project_id: process.env.FIREBASE_PROJECT_ID,
      private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
}

const db = admin.firestore();

function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dotProduct = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function getConsolidatedContext(brandId, queryEmbedding = null, topK = 12) {
  try {
    const guidelinesSnap = await db.collection("brand_guidelines")
      .where("brand_id", "==", brandId)
      .where("status", "==", "approved")
      .get();

    if (guidelinesSnap.empty) return "";

    let allChunks = [];
    for (const guideDoc of guidelinesSnap.docs) {
      const guideData = guideDoc.data();
      const chunksSnap = await guideDoc.ref.collection("chunks").get();
      
      chunksSnap.forEach(cDoc => {
        const cData = cDoc.data();
        allChunks.push({
          text: cData.text,
          embedding: cData.embedding,
          isPrimary: !!guideData.is_primary,
          source: guideData.file_name
        });
      });
    }

    if (allChunks.length === 0) return "";

    if (queryEmbedding) {
      const ranked = allChunks.map(chunk => {
        const similarity = cosineSimilarity(queryEmbedding, chunk.embedding);
        const finalScore = similarity + (chunk.isPrimary ? 0.15 : 0);
        return { ...chunk, finalScore };
      });

      ranked.sort((a, b) => b.finalScore - a.finalScore);
      return ranked.slice(0, topK).map(c => `[Nguồn: ${c.source}${c.isPrimary ? ' - MASTER' : ''}] ${c.text}`).join("\n\n---\n\n");
    }

    return allChunks.slice(0, 10).map(c => c.text).join("\n\n");
  } catch (err) {
    console.error("Context error", err);
    return "";
  }
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    try {
        const { brand, topic, platform, userText, systemPrompt } = req.body;
        const apiKey = process.env.GEMINI_API_KEY;

        let queryEmbedding = null;
        try {
            const embedRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/embedding-001:embedContent?key=${apiKey}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ content: { parts: [{ text: `${topic} ${platform}` }] } })
            });
            const embedData = await embedRes.json();
            queryEmbedding = embedData.embedding?.values;
        } catch (e) {}

        const ragContext = await getConsolidatedContext(brand.id, queryEmbedding);

        const finalPrompt = `
Bạn là chuyên gia Content của ${brand.name}.
Dựa trên bộ Knowledge Base (đã được tổng hợp từ Master Guideline và các tài liệu bổ trợ) dưới đây:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📚 BRAND KNOWLEDGE BASE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${ragContext || "Dùng hồ sơ mặc định bên dưới."}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[HỒ SƠ CHIẾN LƯỢC]
Tính cách: ${brand.personality}
Giọng văn: ${brand.voice}
USP: ${brand.usp?.join(", ")}

[YÊU CẦU]
Chủ đề: ${topic}
Kênh: ${platform}
${userText ? `Ghi chú: ${userText}` : ""}

${systemPrompt}
`;

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ parts: [{ text: finalPrompt }] }] })
        });

        const data = await response.json();
        const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text || "AI không thể phản hồi.";

        res.status(200).json({
            result: resultText,
            citations: ragContext ? ["Knowledge Base Consolidated"] : []
        });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};
