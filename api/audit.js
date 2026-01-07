
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

/**
 * Hàm làm sạch và sửa lỗi JSON mạnh mẽ
 */
function robustJSONParse(text) {
  if (!text) return null;
  let clean = text.trim();

  // 1. Loại bỏ Markdown code blocks
  clean = clean.replace(/```json/gi, '').replace(/```/g, '');

  // 2. Tìm cặp ngoặc nhọn {} ngoài cùng để loại bỏ lời dẫn
  const firstBrace = clean.indexOf('{');
  const lastBrace = clean.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1) {
    clean = clean.substring(firstBrace, lastBrace + 1);
  }

  // 3. Thử Parse
  try {
    return JSON.parse(clean);
  } catch (e) {
    console.error("Standard JSON parse failed, trying specific fixes...");

    // 4. Các kỹ thuật sửa lỗi phổ biến của AI (nếu cần)
    // Ví dụ: Xóa dấu phẩy thừa ở cuối mảng/object: , } -> }
    clean = clean.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');

    try {
      return JSON.parse(clean);
    } catch (e2) {
      return null; // Give up
    }
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

    if (!constructedPrompt && !text) {
      return res.status(400).json({ error: "Missing text content to audit" });
    }

    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(apiKey);

    // Schema Text Only (Soft Schema)
    const auditSchemaText = JSON.stringify({
      summary: "Tóm tắt kết quả audit bằng TIẾNG VIỆT (Bắt buộc).",
      identified_issues: [
        {
          category: "language | ai_logic | brand | product",
          problematic_text: "Trích dẫn nguyên văn đoạn lỗi",
          citation: "Tên quy tắc vi phạm (Label).",
          reason: "Giải thích chi tiết (Tiếng Việt)",
          severity: "High | Medium | Low",
          suggestion: "Đề xuất sửa đổi (Tiếng Việt)"
        }
      ]
    }, null, 2);

    let finalPrompt = constructedPrompt;
    if (!finalPrompt) {
      finalPrompt = `Please audit the following text:\n"""\n${text}\n"""`;
    }

    // Tối ưu Prompt để ép JSON
    finalPrompt += `
\n\n*** FORMAT REQUIREMENT: PURE JSON ONLY ***
1. You must output **ONLY** a valid JSON object.
2. **NO** Markdown code blocks (do not use \`\`\`json).
3. **NO** introductory text or explanations outside the JSON.
4. **NO** trailing commas.
5. If you cannot identify issues, return an empty array for "identified_issues".

REQUIRED JSON STRUCTURE:
${auditSchemaText}
`;

    // Sử dụng gemini-2.0-flash-exp (nhanh và tuân thủ tốt)
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash-exp',
      generationConfig: {
        temperature: 0.1,
        topP: 0.95,
        maxOutputTokens: 8192,
        responseMimeType: "application/json" // Force JSON mode natively
      }
    });

    const response = await model.generateContent(finalPrompt);
    let resultText = response.response.text() || "{}";

    // Xử lý kết quả
    let parsedResult = robustJSONParse(resultText);

    // --- FAIL-SAFE FALLBACK ---
    // Nếu vẫn không parse được, thay vì báo lỗi hệ thống, ta trả về kết quả dạng "Raw Text Warning"
    // Giúp người dùng vẫn đọc được nội dung AI trả về
    if (!parsedResult) {
      console.warn("JSON Parse Failed. Fallback to raw text.");
      parsedResult = {
        summary: "Cảnh báo: AI trả về định dạng không chuẩn xác, nhưng đây là nội dung phân tích:",
        identified_issues: [
          {
            category: "ai_logic",
            severity: "Low",
            problematic_text: "System Format Warning",
            citation: "System",
            reason: "Hệ thống không thể định dạng tự động kết quả này thành bảng. Vui lòng xem nội dung thô bên dưới.",
            suggestion: "Thử lại hoặc đọc phần mô tả chi tiết."
          },
          {
            category: "ai_logic",
            severity: "Medium",
            problematic_text: "Raw AI Response",
            citation: "Debug Info",
            // Nhét toàn bộ text thô vào đây để user đọc được
            reason: resultText.substring(0, 500) + "...",
            suggestion: "Thông tin này dành cho kỹ thuật viên."
          }
        ]
      };
      // Nếu AI trả về text thuần (markdown) thay vì JSON, ta cố gắng đưa nó vào summary
      if (!resultText.trim().startsWith('{')) {
        parsedResult.summary = resultText.substring(0, 1000); // Lấy 1000 ký tự đầu làm summary
      }
    }

    return res.status(200).json({
      success: true,
      result: parsedResult
    });

  } catch (error) {
    console.error("Audit API Error:", error);
    // Trả về lỗi có cấu trúc để Frontend hiển thị đẹp thay vì crash
    return res.status(200).json({
      success: true,
      result: {
        summary: "Lỗi kết nối hoặc xử lý phía máy chủ.",
        identified_issues: [{
          category: "ai_logic",
          severity: "High",
          problematic_text: "Server Error",
          citation: "System",
          reason: error.message || "Unknown Error",
          suggestion: "Vui lòng thử lại sau giây lát."
        }]
      }
    });
  }
}
