// api/rag-generate.js
const fetch = require("node-fetch");
const admin = require("firebase-admin");

// Initialize Firebase Admin
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

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(vecA, vecB) {
  if (vecA.length !== vecB.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * VECTOR RAG: Semantic search using cosine similarity
 */
async function getGuidelinesVector(brandId, query, topK = 5) {
  try {
    console.log(`[Vector RAG] Searching for brand: ${brandId}`);
    console.log(`[Vector RAG] Query: "${query}"`);

    // 1. Get query embedding
    const apiKey = process.env.GEMINI_API_KEY;
    const embedResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/embedding-001:embedContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: { parts: [{ text: query }] }
        })
      }
    );

    const embedData = await embedResponse.json();
    if (embedData.error) {
      console.error("[Vector RAG] Embedding error:", embedData.error);
      return "";
    }

    const queryEmbedding = embedData.embedding?.values;
    if (!queryEmbedding) {
      console.error("[Vector RAG] No embedding returned");
      return "";
    }

    console.log(`[Vector RAG] Query embedding dimension: ${queryEmbedding.length}`);

    // 2. Get approved guidelines
    const guidelinesSnapshot = await db
      .collection("brand_guidelines")
      .where("brand_id", "==", brandId)
      .where("status", "==", "approved")
      .get();

    if (guidelinesSnapshot.empty) {
      console.log(`[Vector RAG] No approved guidelines found for brand: ${brandId}`);
      return "";
    }

    console.log(`[Vector RAG] Found ${guidelinesSnapshot.size} approved guidelines`);

    // 3. Collect all chunks with embeddings
    const allChunks = [];

    for (const guidelineDoc of guidelinesSnapshot.docs) {
      const guideline = guidelineDoc.data();
      const chunksSnapshot = await guidelineDoc.ref.collection("chunks").get();

      if (!chunksSnapshot.empty) {
        console.log(`[Vector RAG] - ${guideline.file_name}: ${chunksSnapshot.size} chunks`);

        chunksSnapshot.forEach((chunkDoc) => {
          const chunk = chunkDoc.data();
          if (chunk.embedding && chunk.text) {
            allChunks.push({
              text: chunk.text,
              embedding: chunk.embedding,
              source: guideline.file_name,
            });
          }
        });
      }
    }

    if (allChunks.length === 0) {
      console.log("[Vector RAG] No chunks with embeddings found");
      return "";
    }

    console.log(`[Vector RAG] Total chunks to search: ${allChunks.length}`);

    // 4. Calculate similarities and rank
    const rankedChunks = allChunks.map((chunk) => ({
      ...chunk,
      similarity: cosineSimilarity(queryEmbedding, chunk.embedding),
    }));

    rankedChunks.sort((a, b) => b.similarity - a.similarity);

    // 5. Get top-K relevant chunks
    const topChunks = rankedChunks.slice(0, topK);

    console.log(`[Vector RAG] Top ${topK} chunks:`);
    topChunks.forEach((chunk, idx) => {
      console.log(`  ${idx + 1}. Similarity: ${chunk.similarity.toFixed(4)} - ${chunk.source}`);
    });

    const context = topChunks.map((chunk) => chunk.text).join("\n\n---\n\n");
    console.log(`[Vector RAG] Final context length: ${context.length} chars`);

    return context;
  } catch (err) {
    console.error("[Vector RAG] Error:", err);
    return "";
  }
}

module.exports = async function handler(req, res) {
  // CORS headers
  const allowedOrigin = req.headers.origin;
  const whitelist = [
    "https://moodbiz---rbac.web.app",
    "http://localhost:5000",
    "http://localhost:3000",
    "http://127.0.0.1:5500"
  ];
  if (whitelist.includes(allowedOrigin)) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  try {
    const { brand, topic, platform, userText, systemPrompt } = req.body || {};
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: "Missing GEMINI_API_KEY" });
    }

    console.log(`\n========== RAG GENERATE START ==========`);
    console.log(`Brand: ${brand?.name || "Unknown"} (${brand?.id})`);
    console.log(`Topic: ${topic}`);
    console.log(`Platform: ${platform}`);

    // 🎯 Vector RAG: Query brand guidelines
    let guidelineContext = "";

    if (brand?.id) {
      const query = `${topic} - ${platform}`;
      guidelineContext = await getGuidelinesVector(brand.id, query, 5);
    }

    // Build final prompt with guideline context
    const finalPrompt = `
Bạn là trợ lý nội dung cho thương hiệu ${brand?.name || ""}.

${guidelineContext ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📚 BRAND GUIDELINES (Tài liệu chuẩn chính thức)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${guidelineContext}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ QUAN TRỌNG: Tuân thủ tuyệt đối các hướng dẫn trong Brand Guidelines ở trên.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

` : ""}
[THÔNG TIN THƯƠNG HIỆU]
Tính cách: ${brand?.personality || ""}
Giọng văn: ${brand?.voice || ""}

[YÊU CẦU CONTENT]
Kênh đăng: ${platform || ""}
Chủ đề: ${topic || ""}
Yêu cầu chi tiết: ${userText || ""}

${systemPrompt || ""}
`;

    console.log(`Final prompt length: ${finalPrompt.length} chars`);

    // Call Gemini API
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + apiKey,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: finalPrompt }] }]
        })
      }
    );

    const data = await response.json();
    if (data.error) {
      console.error("Gemini error:", data.error);
      return res.status(500).json({ error: data.error.message || "Gemini error" });
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "No response";

    console.log(`Response length: ${text.length} chars`);
    console.log(`========== RAG GENERATE END ==========\n`);

    res.status(200).json({
      result: text,
      hasGuidelines: !!guidelineContext,
      guidelineLength: guidelineContext.length
    });
  } catch (e) {
    console.error("ERR_rag_generate:", e);
    res.status(500).json({ error: "Server error", message: e.message });
  }
};
