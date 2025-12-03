// api/rag-generate.js
const fetch = require("node-fetch");

module.exports = async function handler(req, res) {
  // CORS headers – cho phép cả Firebase site và localhost để test
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

  // Trả lời preflight
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

    const finalPrompt = `
Bạn là trợ lý nội dung cho thương hiệu ${brand?.name || ""}.
Tính cách: ${brand?.personality || ""}
Giọng văn: ${brand?.voice || ""}
Kênh đăng: ${platform || ""}
Chủ đề: ${topic || ""}

Yêu cầu chi tiết: ${userText || ""}

${systemPrompt || ""}
`;

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=" + apiKey,
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

    const text =
      data.candidates?.[0]?.content?.parts?.[0]?.text || "No response";

    res.status(200).json({ result: text });
  } catch (e) {
    console.error("ERR_rag_generate:", e);
    res.status(500).json({ error: "Server error" });
  }
};
