
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
        summary: { type: "STRING", description: "Tóm tắt kết quả audit bằng tiếng Việt (Ngắn gọn, súc tích)" },
        identified_issues: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              category: { 
                type: "STRING", 
                enum: ["language", "ai_logic", "brand", "product"], 
                description: "CLASSIFICATION RULES:\n- 'language': Spelling, Grammar, Punctuation, TYPOS, WRONG ABBREVIATIONS (e.g. 'CMR' vs 'CRM'), Clunky phrasing.\n- 'ai_logic': Reasoning errors, Contradictions, Hallucinated Events/Awards, Repetitive Ideas.\n- 'brand': Tone of Voice, Forbidden words.\n- 'product': Wrong Specs/Price/Features." 
              },
              problematic_text: { type: "STRING", description: "Trích dẫn đoạn văn bản bị lỗi" },
              citation: { type: "STRING", description: "Quy tắc bị vi phạm (VD: SOP Rule, Brand Voice)" },
              reason: { type: "STRING", description: "Giải thích chi tiết tại sao đây là lỗi" },
              severity: { type: "STRING", enum: ["High", "Medium", "Low"], description: "Mức độ nghiêm trọng" },
              suggestion: { type: "STRING", description: "Đề xuất sửa đổi cụ thể" }
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
       finalPrompt = `Please audit the following text:\n"""\n${text}\n"""`;
    }

    // SYSTEM REMINDER (SANDWICH)
    finalPrompt += "\n\nIMPORTANT: Think deeply before answering. Separate 'Product Spec Errors' from 'General AI Hallucinations'. Any spelling mistake or wrong abbreviation (e.g. CMR instead of CRM) MUST be 'language'. Output ONLY valid JSON.";

    // Use gemini-3-flash-preview
    const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: [{ role: 'user', parts: [{ text: finalPrompt }] }],
        config: {
            temperature: 0.2, // Tăng nhẹ để AI linh hoạt hơn trong việc phát hiện lỗi ngữ nghĩa (semantic errors)
            topP: 0.9,        // Mở rộng vùng tìm kiếm token một chút
            maxOutputTokens: 8192,
            responseMimeType: "application/json",
            responseSchema: auditSchema
        }
    });

    let resultText = response.text || "{}";
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
