// api/audit.js

const fetch = require("node-fetch");

module.exports = async function handler(req, res) {
  const origin = req.headers.origin;
  const allowedOrigins = [
    "https://moodbiz---rbac.web.app",
    "http://localhost:3000",
    "http://localhost:5000",
    "http://127.0.0.1:5500",
  ];

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    // CHO PHÉP Authorization
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization"
    );
    res.setHeader("Access-Control-Max-Age", "86400");
  }

  // Preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  try {
    const { prompt } = req.body || {};
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Missing GEMINI_API_KEY" });
    }

    const resp = await fetch(
      "https://generativelanguage.googleapis.com/..." + apiKey,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt || "" }] }],
          generationConfig: { responseMimeType: "application/json" },
        }),
      }
    );

    const data = await resp.json();
    if (data.error) {
      return res.status(500).json({ error: data.error.message });
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const result = JSON.parse(text);
    res.status(200).json({ result });
  } catch (e) {
    console.error("ERR_audit:", e);
    res.status(500).json({ error: "Server error" });
  }
};
