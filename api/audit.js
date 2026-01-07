
import admin from 'firebase-admin';

// Initialize Firebase Admin if needed
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  } catch (error) {
    console.error('Firebase admin init error', error);
  }
}

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

  // --- AUTH VERIFICATION ---
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }
  const token = authHeader.split('Bearer ')[1];
  try {
    await admin.auth().verifyIdToken(token);
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized: Token verification failed' });
  }
  // -------------------------

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

    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(apiKey);

    // DEFINING STRICT SCHEMA
    const auditSchema = {
      type: "OBJECT",
      properties: {
        summary: { type: "STRING", description: "Tóm tắt kết quả audit bằng TIẾNG VIỆT. Phải nghiêm khắc và chỉ ra ngay vấn đề lớn nhất." },
        identified_issues: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              category: {
                type: "STRING",
                enum: ["language", "ai_logic", "brand", "product"],
                description: "CLASSIFICATION RULES:\n- 'language': Clunky Vietnamese, Wordiness, Passive Voice, Grammar, Spelling.\n- 'ai_logic': Reasoning errors, Contradictions, Hallucinations.\n- 'brand': Tone violation, Forbidden words.\n- 'product': Wrong Specs/Facts."
              },
              problematic_text: { type: "STRING", description: "Trích dẫn nguyên văn đoạn lỗi" },
              citation: { type: "STRING", description: "Tên quy tắc vi phạm (Label). VD: 'Văn phong tự nhiên', 'Loại bỏ từ thừa'. KHÔNG dùng mã code." },
              reason: { type: "STRING", description: "Giải thích lỗi thật chi tiết và khó tính (Bằng TIẾNG VIỆT)" },
              severity: { type: "STRING", enum: ["High", "Medium", "Low"], description: "High = Sai sự thật/Cấm. Medium = Lủng củng/Sáo rỗng. Low = Lỗi vặt." },
              suggestion: { type: "STRING", description: "Viết lại câu này cho thật hay và tự nhiên (Tiếng Việt)" }
            },
            required: ["category", "problematic_text", "citation", "reason", "severity", "suggestion"]
          }
        }
      },
      required: ["summary", "identified_issues"]
    };

    // Construct prompt
    let finalPrompt = constructedPrompt;
    if (!finalPrompt) {
      finalPrompt = `Please audit the following text strictly:\n"""\n${text}\n"""`;
    }

    // SYSTEM REMINDER (SANDWICH) - Reinforced for EXTREME STRICTNESS
    finalPrompt += "\n\n*** SYSTEM OVERRIDE: PEDANTIC MODE ON ***\n1. Be an extremely strict editor. Find faults in flow, word choice, and logic.\n2. **Translationese Check:** If the Vietnamese sounds like translated English (e.g. structure 'Adj + Noun' where 'Noun + Adj' is better, or overuse of 'của'), FLAG IT as 'Language Naturalness'.\n3. **Cliché Check:** Flag words like 'tối ưu hóa', 'giải pháp hàng đầu' if they lack context.\n4. **Output:** MUST BE IN VIETNAMESE. \n5. **Citation:** Use DISPLAY NAMES (Labels), never codes.\n6. Return valid JSON.";

    // Use gemini-2.0-flash-exp with correct SDK syntax
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash-exp',
      generationConfig: {
        temperature: 0.1, // Very low temperature for consistent, strict checking
        topP: 0.9,
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
        responseSchema: auditSchema
      }
    });

    const response = await model.generateContent(finalPrompt);

    let resultText = response.response.text() || "{}";

    // Robust cleaning on backend
    resultText = resultText.replace(/```json/gi, "").replace(/```/g, "").trim();

    // Attempt to parse JSON
    let parsedResult;
    try {
      parsedResult = JSON.parse(resultText);
    } catch (parseError) {
      console.error("Backend JSON Parse Error:", parseError);
      console.error("Raw Text:", resultText);

      parsedResult = {
        summary: "Lỗi hệ thống khi xử lý kết quả AI (JSON Error).",
        identified_issues: [{
          category: "ai_logic",
          problematic_text: "System Error",
          citation: "System",
          reason: "AI trả về định dạng không hợp lệ. Vui lòng thử lại.",
          severity: "Low",
          suggestion: "Thử lại Audit"
        }]
      };
    }

    return res.status(200).json({
      success: true,
      result: parsedResult
    });

  } catch (error) {
    console.error("Audit API Error:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Internal Server Error"
    });
  }
}
