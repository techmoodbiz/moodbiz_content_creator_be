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
 * Hàm parse JSON an toàn (Đã nâng cấp)
 */
function robustJSONParse(text) {
  if (!text) return null;

  // 1. Chuyển về string và làm sạch cơ bản
  let clean = typeof text === 'string' ? text : JSON.stringify(text);
  clean = clean.trim();

  // 2. Loại bỏ Markdown code blocks
  clean = clean.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');

  // 3. Tìm cặp ngoặc nhọn {} ngoài cùng
  const firstBrace = clean.indexOf('{');
  const lastBrace = clean.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    clean = clean.substring(firstBrace, lastBrace + 1);
  }

  // 4. Loại bỏ comments (// ...) đôi khi AI thêm vào
  clean = clean.replace(/\/\/.*$/gm, '');

  // 5. Thử Parse JSON chuẩn
  try {
    return JSON.parse(clean);
  } catch (e) {
    // 6. Nếu lỗi, dùng Regex mạnh để xóa dấu phẩy thừa trước dấu đóng }, ]
    try {
      // Regex: tìm dấu phẩy theo sau bởi khoảng trắng và dấu đóng
      const fixed = clean.replace(/,(\s*[}\]])/g, '$1');
      return JSON.parse(fixed);
    } catch (e2) {
      console.error("JSON Parse Error Detail:", e2.message, "Raw Text:", text);
      return null; // Parse thất bại hoàn toàn
    }
  }
}

export default async function handler(req, res) {
  // CORS Configuration
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, ' +
    'Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );

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

  const parts = authHeader.split('Bearer ');
  const token = parts[1]?.trim();
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: Missing token' });
  }

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
      throw new Error('Server Misconfiguration: Missing API Key');
    }

    if (!constructedPrompt && !text) {
      return res.status(400).json({ error: 'Missing text content to audit' });
    }

    const { GoogleGenerativeAI, SchemaType } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);

    // --- CẤU HÌNH STRICT SCHEMA ---
    // Ép buộc Gemini trả về đúng cấu trúc này, không được sai lệch.
    const auditResponseSchema = {
      type: "OBJECT", // SchemaType.OBJECT
      properties: {
        summary: { type: "STRING" },
        identified_issues: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              category: { type: "STRING", enum: ["language", "ai_logic", "brand", "product"] },
              problematic_text: { type: "STRING" },
              citation: { type: "STRING" },
              reason: { type: "STRING" },
              severity: { type: "STRING", enum: ["High", "Medium", "Low"] },
              suggestion: { type: "STRING" }
            },
            required: ["category", "problematic_text", "reason", "suggestion", "severity"]
          }
        }
      },
      required: ["summary", "identified_issues"]
    };

    let finalPrompt = constructedPrompt;
    if (!finalPrompt) {
      finalPrompt = `Please audit the following text:\n"""\n${text}\n"""`;
    }

    // Tối ưu Prompt
    finalPrompt += `
*** CRITICAL INSTRUCTION ***
You must output PURE JSON matching the provided schema.
Do NOT include markdown formatting like \`\`\`json.
Do NOT include any introductory text.
Ensure "summary" is in Vietnamese.
Ensure "reason" and "suggestion" are in Vietnamese.
`;

    // Sử dụng gemini-2.0-flash-exp
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash-exp',
      generationConfig: {
        temperature: 0.1, // Cực thấp để đảm bảo logic và format
        topP: 0.95,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
        responseSchema: auditResponseSchema // KEY FIX: Ép kiểu Schema
      },
    });

    const response = await model.generateContent(finalPrompt);

    // Lấy text JSON trả về
    let resultText = '';
    try {
      if (response && response.response && typeof response.response.text === 'function') {
        resultText = response.response.text();
      } else {
        console.warn('Unexpected Gemini response structure:', response);
        resultText = JSON.stringify(response);
      }
    } catch (e) {
      console.error('Error extracting text from Gemini response:', e);
      resultText = '{}';
    }

    // Parse kết quả
    let parsedResult = robustJSONParse(resultText);

    // --- FAIL-SAFE FALLBACK ---
    if (!parsedResult) {
      console.warn('JSON Parse Failed even with Schema. Fallback active.');
      // Log raw text để debug nếu vẫn lỗi
      console.log('Raw Failed JSON:', resultText);

      parsedResult = {
        summary: 'Cảnh báo: Hệ thống gặp lỗi khi đọc dữ liệu từ AI. Dưới đây là nội dung thô:',
        identified_issues: [
          {
            category: 'ai_logic',
            severity: 'Low',
            problematic_text: 'System Format Warning',
            citation: 'System',
            reason: 'Không thể phân tích định dạng JSON.',
            suggestion: 'Vui lòng thử lại.',
          },
          {
            category: 'ai_logic',
            severity: 'Medium',
            problematic_text: 'Raw Output',
            citation: 'Debug',
            reason: (resultText || '').substring(0, 1000), // Show raw text
            suggestion: 'Contact Admin',
          },
        ],
      };
    }

    return res.status(200).json({
      success: true,
      result: parsedResult,
    });
  } catch (error) {
    console.error('Audit API Error:', error);
    return res.status(200).json({
      success: true,
      result: {
        summary: 'Lỗi kết nối hoặc xử lý phía máy chủ.',
        identified_issues: [
          {
            category: 'ai_logic',
            severity: 'High',
            problematic_text: 'Server Error',
            citation: 'System',
            reason: error.message || 'Unknown Error',
            suggestion: 'Vui lòng thử lại sau giây lát.',
          },
        ],
      },
    });
  }
}