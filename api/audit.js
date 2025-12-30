
const fetch = require('node-fetch');

module.exports = async function handler(req, res) {
  // CORS Configuration
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // 1. Nhận Prompt đã được lắp ráp từ Frontend (thông qua các Service: BrandService, ProductService...)
    const { constructedPrompt, text } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      throw new Error("Server Misconfiguration: Missing API Key");
    }

    // 2. Fallback logic: Nếu Client cũ không gửi constructedPrompt, ta dùng một prompt cơ bản
    // Tuy nhiên, kiến trúc mới khuyến khích Client chịu trách nhiệm tạo Prompt.
    let finalPrompt = constructedPrompt;
    if (!finalPrompt) {
       if (!text) return res.status(400).json({ error: "Missing text content to audit" });
       finalPrompt = `Please audit the following text based on general marketing standards:\n"${text}"\nOutput JSON format.`;
    }

    // 3. Gọi Google Gemini API
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: finalPrompt }] }],
        generationConfig: {
          temperature: 0.1, // Low temperature for consistent audit results
          maxOutputTokens: 8192,
          responseMimeType: "application/json"
        }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Gemini API Error:", errText);
      throw new Error(`Gemini API Failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    // 4. Trả kết quả thô về cho Client xử lý (Client có hàm safeJSONParse)
    // Backend chỉ đóng vai trò Proxy bảo mật.
    const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

    return res.status(200).json({
      success: true,
      result: resultText
    });

  } catch (error) {
    console.error("Audit API Error:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Internal Server Error"
    });
  }
};
