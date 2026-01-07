
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
        summary: { type: "STRING", description: "Tóm tắt kết quả audit bằng tiếng Việt (Ngắn gọn, súc tích)" },
        identified_issues: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              category: {
                type: "STRING",
                enum: ["language", "ai_logic", "brand", "product"],
                description: "CLASSIFICATION RULES:\n- 'language': Spelling, Grammar, Punctuation, TYPOS, WRONG ABBREVIATIONS (e.g. 'CMR' vs 'CRM'), Clunky phrasing.\n- 'ai_logic': Reasoning errors, Contradictions, Hallucinated Events/Awards, Repetitive Ideas.\n- 'brand': Tone of Voice, Forbidden words, Generic AI tone.\n- 'product': Wrong Specs/Price/Features."
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

    // Use gemini-2.0-flash-exp with correct SDK syntax
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash-exp',
      generationConfig: {
        temperature: 0.2,
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

    // Attempt to parse JSON on server side to catch errors early
    let parsedResult;
    try {
      parsedResult = JSON.parse(resultText);
    } catch (parseError) {
      console.error("Backend JSON Parse Error:", parseError);
      console.error("Raw Text:", resultText);

      // Fallback: Return a valid error object structure if parsing fails
      parsedResult = {
        summary: "Error parsing AI response on server.",
        identified_issues: [{
          category: "ai_logic",
          problematic_text: "System Error",
          citation: "JSON Parse Failure",
          reason: "The AI returned an invalid format. Please try again.",
          severity: "Low",
          suggestion: "Retry Audit"
        }]
      };
    }

    return res.status(200).json({
      success: true,
      result: parsedResult // Return OBJECT, not string
    });

  } catch (error) {
    console.error("Audit API Error:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Internal Server Error"
    });
  }
}
