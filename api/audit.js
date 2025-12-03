// api/audit.js
const fetch = require('node-fetch');

module.exports = async function handler(req, res) {
  // CORS giống rag-generate
  const allowedOrigin = req.headers.origin;
  const whitelist = [
    'https://moodbiz---rbac.web.app',
    'http://localhost:5000',
    'http://localhost:3000',
    'http://127.0.0.1:5500',
  ];

  if (whitelist.includes(allowedOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST allowed' });
  }

  try {
    const { brand, prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('GEMINI_API_KEY not found');
      return res.status(500).json({ error: 'Missing GEMINI_API_KEY' });
    }

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${apiKey}`;

    // BỎ responseMimeType - để Gemini trả về text tự nhiên
    const requestBody = {
      contents: [{
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 8192,
      }
    };

    console.log('Calling Gemini API for audit...');
    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Gemini API error:', errorText);
      return res.status(response.status).json({
        error: 'Gemini API error',
        details: errorText
      });
    }

    const data = await response.json();

    if (data.error) {
      console.error('Gemini error (audit):', data.error);
      return res.status(500).json({
        error: data.error.message || 'Gemini error'
      });
    }

    // LẤY TEXT TRỰC TIẾP - không parse JSON
    const textResult = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    console.log('AUDIT_RAW_TEXT:', textResult.substring(0, 500)); // Log 500 ký tự đầu

    // TRẢ VỀ TEXT NGUYÊN BẢN
    return res.status(200).json({
      result: textResult,
      success: true
    });

  } catch (e) {
    console.error('ERR/audit:', e);
    return res.status(500).json({
      error: 'Server error',
      message: e.message
    });
  }
};
