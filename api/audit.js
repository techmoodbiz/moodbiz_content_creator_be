
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
    // 1. Nhận Prompt đã được lắp ráp từ Frontend
    const { constructedPrompt, text } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      throw new Error("Server Misconfiguration: Missing API Key");
    }

    let finalPrompt = constructedPrompt;
    if (!finalPrompt) {
       if (!text) return res.status(400).json({ error: "Missing text content to audit" });
       finalPrompt = `Please audit the following text based on general marketing standards:\n"${text}"\nOutput JSON format.`;
    }

    // 2. Định nghĩa Schema để ép kiểu dữ liệu trả về (Strict JSON)
    const auditSchema = {
      type: "OBJECT",
      properties: {
        summary: { type: "STRING", description: "Tóm tắt kết quả audit bằng tiếng Việt" },
        identified_issues: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              category: { type: "STRING", enum: ["language", "ai_logic", "brand", "product"], description: "Loại lỗi" },
              problematic_text: { type: "STRING", description: "Đoạn văn bản bị lỗi" },
              citation: { type: "STRING", description: "Quy tắc bị vi phạm" },
              reason: { type: "STRING", description: "Giải thích lý do lỗi" },
              severity: { type: "STRING", enum: ["High", "Medium", "Low"], description: "Mức độ nghiêm trọng" },
              suggestion: { type: "STRING", description: "Gợi ý sửa đổi" }
            },
            required: ["category", "problematic_text", "reason", "severity", "suggestion"]
          }
        }
      },
      required: ["summary", "identified_issues"]
    };

    // 3. Gọi Google Gemini API
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: finalPrompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 8192,
          responseMimeType: "application/json",
          responseSchema: auditSchema // Áp dụng Schema
        }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Gemini API Error:", errText);
      throw new Error(`Gemini API Failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    // 4. Trả kết quả
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
