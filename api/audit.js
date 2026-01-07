
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

function cleanAndParseJSON(text) {
  let clean = text.trim();
  // Remove Markdown code blocks
  if (clean.includes('```')) {
    clean = clean.replace(/```json/gi, '').replace(/```/g, '');
  }

  // Attempt to find the outer JSON object
  const firstBrace = clean.indexOf('{');
  const lastBrace = clean.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1) {
    clean = clean.substring(firstBrace, lastBrace + 1);
  }

  return JSON.parse(clean);
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

    // DEFINING STRICT SCHEMA TEXT FOR PROMPT
    // We inject this into the prompt instead of strict generationConfig to avoid validation crashes
    const auditSchemaText = JSON.stringify({
      summary: "Tóm tắt kết quả audit bằng TIẾNG VIỆT. Phải nghiêm khắc và chỉ ra ngay vấn đề lớn nhất.",
      identified_issues: [
        {
          category: "language | ai_logic | brand | product",
          problematic_text: "Trích dẫn nguyên văn đoạn lỗi",
          citation: "Tên quy tắc vi phạm (Label). VD: 'Văn phong tự nhiên'. KHÔNG dùng mã code.",
          reason: "Giải thích lỗi thật chi tiết và khó tính (Bằng TIẾNG VIỆT)",
          severity: "High | Medium | Low",
          suggestion: "Viết lại câu này cho thật hay và tự nhiên (Tiếng Việt)"
        }
      ]
    }, null, 2);

    // Construct prompt
    let finalPrompt = constructedPrompt;
    if (!finalPrompt) {
      finalPrompt = `Please audit the following text strictly:\n"""\n${text}\n"""`;
    }

    // SYSTEM REMINDER (SANDWICH) - Reinforced for EXTREME STRICTNESS
    finalPrompt += `
\n\n*** SYSTEM OVERRIDE: PEDANTIC MODE ON ***
1. Be an extremely strict editor. Find faults in flow, word choice, and logic.
2. **Translationese Check:** If the Vietnamese sounds like translated English, FLAG IT.
3. **Cliché Check:** Flag words like 'tối ưu hóa', 'giải pháp hàng đầu' if they lack context.
4. **Citation:** Use DISPLAY NAMES (Labels), never codes.
5. **Output Format:** You MUST return valid JSON adhering to the schema below. Do not wrap in markdown code blocks.

REQUIRED JSON SCHEMA:
${auditSchemaText}
`;

    // Use gemini-2.0-flash-exp 
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash-exp',
      generationConfig: {
        temperature: 0.1,
        topP: 0.9,
        maxOutputTokens: 8192,
        responseMimeType: "application/json" // Enforce JSON output but without strict schema validation object
      }
    });

    const response = await model.generateContent(finalPrompt);
    let resultText = response.response.text() || "{}";

    // Attempt to parse JSON
    let parsedResult;
    try {
      parsedResult = cleanAndParseJSON(resultText);
    } catch (parseError) {
      console.error("Backend JSON Parse Error:", parseError);
      console.error("Raw Text:", resultText);

      parsedResult = {
        summary: "Lỗi hệ thống khi xử lý kết quả AI (JSON Error).",
        identified_issues: [{
          category: "ai_logic",
          problematic_text: "System Error",
          citation: "System",
          reason: "AI trả về định dạng không hợp lệ. Vui lòng thử lại. Raw: " + resultText.substring(0, 50),
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
