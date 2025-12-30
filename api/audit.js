
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

    // Input Validation
    if (!constructedPrompt && !text) {
        return res.status(400).json({ error: "Missing text content to audit" });
    }

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
              problematic_text: { type: "STRING", description: "Đoạn văn bản bị lỗi (Trích dẫn chính xác, max 150 ký tự)" },
              citation: { type: "STRING", description: "Quy tắc bị vi phạm" },
              reason: { type: "STRING", description: "Giải thích lý do" },
              severity: { type: "STRING", enum: ["High", "Medium", "Low"], description: "Mức độ" },
              suggestion: { type: "STRING", description: "Gợi ý sửa đổi" }
            },
            required: ["category", "problematic_text", "reason", "severity", "suggestion"]
          }
        }
      },
      required: ["summary", "identified_issues"]
    };

    // Construct prompt
    let finalPrompt = constructedPrompt;
    if (!finalPrompt) {
       // Fallback simple prompt
       finalPrompt = `Please audit the following text based on general marketing standards:\n"""\n${text}\n"""`;
    }

    // REINFORCE JSON INSTRUCTION AT THE VERY END (Sandwich Prompting)
    // Điều này cực kỳ quan trọng với nội dung dài, giúp AI nhớ lại nhiệm vụ format cuối cùng
    finalPrompt += "\n\nSYSTEM REMINDER: You MUST output a valid JSON object strictly matching the defined schema. No Markdown formatting. No introductory text.";

    // Use gemini-3-flash-preview as requested
    const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: [{ role: 'user', parts: [{ text: finalPrompt }] }],
        config: {
            temperature: 0.1, // Low temperature for deterministic output
            maxOutputTokens: 8192,
            responseMimeType: "application/json",
            responseSchema: auditSchema
        }
    });

    let resultText = response.text || "{}";

    // Standardize output
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
