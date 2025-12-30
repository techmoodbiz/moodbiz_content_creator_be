
export default async function handler(req, res) {
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
    const { constructedPrompt, text } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      throw new Error("Server Misconfiguration: Missing API Key");
    }

    let finalPrompt = constructedPrompt;
    if (!finalPrompt) {
       if (!text) return res.status(400).json({ error: "Missing text content to audit" });
       finalPrompt = `Please audit the following text based on general marketing standards:\n"""\n${text}\n"""\nOutput JSON format.`;
    } else {
        // Nếu prompt đã được construct, hãy đảm bảo text được wrap an toàn nếu chưa có
        // Tuy nhiên constructedPrompt thường đã include text. Chúng ta append instruction cuối cùng.
    }

    // Add explicit instruction to forbid markdown even if schema is used
    finalPrompt += "\n\nIMPORTANT: Output RAW JSON only. Do not wrap in markdown code blocks (```json).";

    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey: apiKey });

    // DEFINING STRICT SCHEMA
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
              citation: { type: "STRING", description: "Quy tắc bị vi phạm (Trích dẫn cụ thể từ SOP/Brand/Product)" },
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

    const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: [{ text: finalPrompt }],
        config: {
            temperature: 0.1,
            maxOutputTokens: 8192,
            responseMimeType: "application/json",
            responseSchema: auditSchema
        }
    });

    let resultText = response.text || "{}";

    // Clean up markdown if AI ignored instructions
    resultText = resultText.replace(/```json/g, "").replace(/```/g, "").trim();

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
}
