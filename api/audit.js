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
 * Hàm parse JSON an toàn
 */
function robustJSONParse(text) {
  if (!text) return null;

  // 1. Chuyển về string và làm sạch cơ bản
  let clean = typeof text === 'string' ? text : JSON.stringify(text);
  clean = clean.trim();

  // 2. Loại bỏ Markdown code blocks
  clean = clean.replace(/```json/gi, '').replace(/```/g, '');

  // 3. Tìm cặp ngoặc nhọn {} ngoài cùng (để loại bỏ lời dẫn nếu có)
  const firstBrace = clean.indexOf('{');
  const lastBrace = clean.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    clean = clean.substring(firstBrace, lastBrace + 1);
  }

  // 4. Thử Parse JSON chuẩn
  try {
    return JSON.parse(clean);
  } catch (e) {
    // 5. Nếu lỗi, thử fix các lỗi phổ biến của AI
    try {
      const fixed = clean
        .replace(/,\s*}/g, '}') // { "a": 1, } -> { "a": 1 }
        .replace(/,\s*]/g, ']'); // [1, 2, ] -> [1, 2]
      return JSON.parse(fixed);
    } catch (e2) {
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

    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);

    // Schema Text Only (Soft Schema - inject vào prompt)
    const auditSchemaText = JSON.stringify(
      {
        summary: 'Tóm tắt kết quả audit bằng TIẾNG VIỆT (Bắt buộc).',
        identified_issues: [
          {
            category: 'language | ai_logic | brand | product',
            problematic_text: 'Trích dẫn nguyên văn đoạn lỗi',
            citation: 'Tên quy tắc vi phạm (Label).',
            reason: 'Giải thích chi tiết (Tiếng Việt)',
            severity: 'High | Medium | Low',
            suggestion: 'Đề xuất sửa đổi (Tiếng Việt)',
          },
        ],
      },
      null,
      2
    );

    let finalPrompt = constructedPrompt;
    if (!finalPrompt) {
      finalPrompt = `Please audit the following text:\n"""\n${text}\n"""`;
    }

    // Tối ưu Prompt để ép JSON
    finalPrompt += `
*** FORMAT REQUIREMENT: PURE JSON ONLY ***
1. You must output ONLY a valid JSON object.
2. NO Markdown code blocks (do not use \`\`\`json).
3. NO introductory text or explanations outside the JSON.
4. NO trailing commas.
5. If you cannot identify issues, return an empty array for "identified_issues".

REQUIRED JSON STRUCTURE:
${auditSchemaText}
`;

    // Sử dụng gemini-2.0-flash-exp (Model 1.5-flash bị lỗi 404 trên v1beta)
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash-exp',
      generationConfig: {
        temperature: 0.2,
        topP: 0.95,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
      },
    });

    const response = await model.generateContent(finalPrompt);

    // Lấy text JSON trả về
    let resultText = '';
    try {
      // response.response.text() is a function call
      if (response && response.response && typeof response.response.text === 'function') {
        resultText = response.response.text();
      } else {
        // Fallback for unexpected SDK structure
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
      console.warn('JSON Parse Failed. Fallback to raw text.');

      parsedResult = {
        summary: 'Cảnh báo: AI trả về định dạng không chuẩn xác, nhưng đây là nội dung phân tích:',
        identified_issues: [
          {
            category: 'ai_logic',
            severity: 'Low',
            problematic_text: 'System Format Warning',
            citation: 'System',
            reason:
              'Hệ thống không thể định dạng tự động kết quả này thành bảng. Vui lòng xem nội dung thô bên dưới.',
            suggestion: 'Thử lại hoặc đọc phần mô tả chi tiết.',
          },
          {
            category: 'ai_logic',
            severity: 'Medium',
            problematic_text: 'Raw AI Response',
            citation: 'Debug Info',
            reason: (resultText || '').substring(0, 800) + '...',
            suggestion: 'Thông tin này dành cho kỹ thuật viên.',
          },
        ],
      };

      if (resultText && !resultText.trim().startsWith('{')) {
        parsedResult.summary = resultText.substring(0, 500) + '...';
      }
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