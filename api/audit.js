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
 * Hàm parse JSON an toàn (đã nâng cấp) - THUẦN JS
 */
function robustJSONParse(text) {
  if (!text) return null;

  // 1. Chuyển về string và làm sạch cơ bản
  let clean = typeof text === 'string' ? text : JSON.stringify(text);
  clean = clean.trim();

  // 2. Loại bỏ Markdown code blocks ở đầu/cuối
  clean = clean
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '');

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
    // 6. Nếu lỗi, cố gắng sửa các lỗi phổ biến
    try {
      // Trailing commas
      let fixed = clean.replace(/,(\s*[}\]])/g, '$1');

      // Missing commas giữa các object trong array: }{ hoặc } {
      fixed = fixed.replace(/}\s*{/g, '},{');

      return JSON.parse(fixed);
    } catch (e2) {
      console.error(
        'JSON Parse Error Detail:',
        e2.message,
        'Raw Text Length:',
        clean.length
      );
      return null;
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
    const { constructedPrompt, text, maxIssues } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      throw new Error('Server Misconfiguration: Missing API Key');
    }

    if (!constructedPrompt && !text) {
      return res.status(400).json({ error: 'Missing text content to audit' });
    }

    const { GoogleGenerativeAI, SchemaType } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);

    // --- STRICT SCHEMA ---
    const auditResponseSchema = {
      type: SchemaType.OBJECT,
      properties: {
        summary: { type: SchemaType.STRING },
        identified_issues: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              category: {
                type: SchemaType.STRING,
                enum: ['language', 'ai_logic', 'brand', 'product'],
              },
              problematic_text: { type: SchemaType.STRING },
              citation: { type: SchemaType.STRING },
              reason: { type: SchemaType.STRING },
              severity: {
                type: SchemaType.STRING,
                enum: ['High', 'Medium', 'Low'],
              },
              suggestion: { type: SchemaType.STRING },
            },
            required: ['category', 'problematic_text', 'reason', 'suggestion', 'severity'],
          },
        },
      },
      required: ['summary', 'identified_issues'],
    };

    let finalPrompt = constructedPrompt;
    if (!finalPrompt) {
      finalPrompt = `Please audit the following text:\n"""\n${text}\n"""`;
    }

    // Số lỗi tối đa FE có thể truyền lên (mặc định 50)
    const maxItems = Number.isInteger(maxIssues) && maxIssues > 0 ? maxIssues : 50;

    // Prompt: KHÔNG khóa cứng 15 lỗi
    finalPrompt += `
*** CRITICAL INSTRUCTION ***
1. Output PURE JSON matching the provided schema.
2. Do NOT include markdown formatting like \`\`\`json.
3. Do NOT include any introductory text.
4. Ensure "summary" is in Vietnamese and CONCISE (under 100 words).
5. Return ALL important "identified_issues" you can find, sorted by severity (High > Medium > Low).
6. If there are too many issues, ưu tiên các lỗi nghiêm trọng và ảnh hưởng lớn nhất.
7. "reason" và "suggestion" phải bằng tiếng Việt.
`;

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash-exp',
      generationConfig: {
        temperature: 0.1,
        topP: 0.95,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
        responseSchema: auditResponseSchema,
      },
    });

    const response = await model.generateContent(finalPrompt);

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

    let parsedResult = robustJSONParse(resultText);

    // Backend limit (mặc định 50, hoặc theo maxIssues)
    if (
      parsedResult &&
      parsedResult.identified_issues &&
      Array.isArray(parsedResult.identified_issues)
    ) {
      parsedResult.identified_issues = parsedResult.identified_issues.slice(0, maxItems);
    }

    // --- FAIL-SAFE FALLBACK ---
    if (!parsedResult) {
      console.warn('JSON Parse Failed even with Schema. Fallback active.');
      console.log('Raw Failed JSON (First 500 chars):', resultText.substring(0, 500));

      parsedResult = {
        summary:
          'Cảnh báo: Hệ thống gặp lỗi khi đọc dữ liệu từ AI (JSON Syntax Error). Dưới đây là nội dung thô:',
        identified_issues: [
          {
            category: 'ai_logic',
            severity: 'Low',
            problematic_text: 'System Format Warning',
            citation: 'System',
            reason:
              'Dữ liệu trả về từ AI không đúng định dạng JSON chuẩn hoặc bị cắt ngắn.',
            suggestion: 'Vui lòng thử lại với đoạn văn bản ngắn hơn.',
          },
          {
            category: 'ai_logic',
            severity: 'Medium',
            problematic_text: 'Raw Output Preview',
            citation: 'Debug',
            reason: (resultText || '').substring(0, 1000),
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
