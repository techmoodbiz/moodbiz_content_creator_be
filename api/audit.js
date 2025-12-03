// api/audit.js
const fetch = require('node-fetch');

module.exports = async function handler(req, res) {
  // CORS - giống rag-generate
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
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // ✅ ĐÚNG: Lấy cả brand VÀ prompt
    const { brand, prompt } = req.body;

    // Validate
    if (!prompt || typeof prompt !== 'string') {
      console.error('Invalid prompt:', prompt);
      return res.status(400).json({ error: 'Prompt is required and must be a string' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('GEMINI_API_KEY not found in environment');
      return res.status(500).json({ error: 'API key not configured' });
    }

    // ✅ SỬ DỤNG MODEL ĐÚNG (gemini-2.5-flash-preview-09-2025 giống rag-generate và generate)
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

    const requestBody = {
      contents: [{
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 8192,
      }
    };

    console.log('🔍 Calling Gemini API for audit...');
    console.log('📝 Prompt length:', prompt.length);

    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Gemini API error:', response.status, errorText);
      return res.status(response.status).json({
        error: `Gemini API error: ${response.status}`,
        details: errorText
      });
    }

    const data = await response.json();

    if (data.error) {
      console.error('❌ Gemini returned error:', data.error);
      return res.status(500).json({
        error: data.error.message || 'Gemini error'
      });
    }

    // ✅ SỬA: Thêm [0] vào đúng chỗ
    const textResult = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (!textResult) {
      console.error('❌ No text result from Gemini');
      return res.status(500).json({ error: 'No response from AI' });
    }

    console.log('✅ AUDIT_SUCCESS - Text length:', textResult.length);
    console.log('📄 Preview:', textResult.substring(0, 200));

    // ✅ TRẢ VỀ TEXT THÔI (frontend sẽ tự parse)
    return res.status(200).json({
      result: textResult,
      success: true
    });

  } catch (e) {
    console.error('❌ ERR/audit:', e.message);
    console.error('Stack:', e.stack);
    return res.status(500).json({
      error: 'Server error',
      message: e.message
    });
  }
};
