// api/audit.js

const fetch = require("node-fetch");

module.exports = async function handler(req, res) {
  // CORS giống rag-generate
  const allowedOrigin = req.headers.origin;
  const whitelist = [
    "https://moodbiz---rbac.web.app",
    "http://localhost:5000",
    "http://localhost:3000",
    "http://127.0.0.1:5500",
  ];

  if (whitelist.includes(allowedOrigin)) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");

    if (req.method === "OPTIONS") {
      return res.status(200).end();
    }
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  try {
    const { brand, prompt } = req.body || {};
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Missing GEMINI_API_KEY" });
    }

    // Prompt cho Auditor (dùng prompt hệ thống bạn đã định nghĩa)
    const finalPrompt = prompt || "";

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      "gemini-2.5-flash-preview-09-2025:generateContent?key=" +
      apiKey,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: finalPrompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
          },
        }),
      }
    );

    const data = await response.json();

    if (data.error) {
      console.error("Gemini error (audit):", data.error);
      return res
        .status(500)
        .json({ error: data.error.message || "Gemini error" });
    }

    let text = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

    // Log để debug
    console.log("AUDIT_RAW_TEXT:", text);

    // Làm sạch text trước khi parse
    text = text.trim();

    // Loại bỏ markdown code blocks nếu có
    if (text.startsWith("```")) {
      text = text.replace(/^```json\s*/i, "").replace(/^```/i, "");
      text = text.replace(/```\s*$/, "").trim();
    }

    // Loại bỏ control characters không hợp lệ trong JSON (0x00-0x1F trừ \n\r\t)
    // Giữ lại \n \r \t vì chúng hợp lệ trong JSON string
    text = text.replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F]/g, " ");

    let result;
    try {
      result = JSON.parse(text);
    } catch (e) {
      console.error("ERR_parse_audit:", e);
      console.error("Cleaned text:", text);
      return res
        .status(500)
        .json({ error: "Invalid JSON returned from Gemini" });
    }

    return res.status(200).json({ result });
  } catch (e) {
    console.error("ERR_audit:", e);
    return res.status(500).json({ error: "Server error" });
  }
};
