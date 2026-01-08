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
 * Robust JSON Parser V2
 * Uses substring extraction instead of just regex to handle "Here is the JSON" preambles.
 */
function robustJSONParse(text) {
  if (!text) return null;
  let clean = String(text);

  // 1. Extract the main JSON object (Find first '{' and last '}')
  const firstBrace = clean.indexOf('{');
  const lastBrace = clean.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1) {
    clean = clean.substring(firstBrace, lastBrace + 1);
  } else {
    // If no braces found, it's not a JSON object
    return null;
  }

  // 2. Try direct parse after extraction
  try {
    return JSON.parse(clean);
  } catch (e) {
    // Continue to repair
  }

  // 3. Remove comments (// ...) and trailing commas
  clean = clean
    .replace(/\/\/.*$/gm, '') // Remove JS comments
    .replace(/,(\s*[}\]])/g, '$1') // Remove trailing commas
    .replace(/([{,]\s*)([a-zA-Z0-9_]+?)\s*:/g, '$1"$2":'); // Fix unquoted keys

  try {
    return JSON.parse(clean);
  } catch (e) { }

  // 4. Handle Truncated JSON (Attempt to close open structures)
  try {
    const openBraces = (clean.match(/{/g) || []).length;
    const closeBraces = (clean.match(/}/g) || []).length;
    const openBrackets = (clean.match(/\[/g) || []).length;
    const closeBrackets = (clean.match(/\]/g) || []).length;

    if (openBrackets > closeBrackets) clean += ']'.repeat(openBrackets - closeBrackets);
    if (openBraces > closeBraces) clean += '}'.repeat(openBraces - closeBraces);

    return JSON.parse(clean);
  } catch (e) {
    console.warn("JSON Repair Failed:", e.message);
  }

  return null;
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

    // --- SCHEMA DEFINITION (Relaxed for stability) ---
    const auditResponseSchema = {
      type: SchemaType.OBJECT,
      properties: {
        summary: { type: SchemaType.STRING },
        identified_issues: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              category: { type: SchemaType.STRING }, // Removed strict enum to prevent validation errors
              problematic_text: { type: SchemaType.STRING },
              citation: { type: SchemaType.STRING, description: "Must use exact Rule Label from SOP if applicable" },
              reason: { type: SchemaType.STRING },
              severity: { type: SchemaType.STRING },
              suggestion: { type: SchemaType.STRING }
            },
            required: ["category", "problematic_text", "reason", "suggestion"]
          }
        }
      },
      required: ["summary", "identified_issues"]
    };

    let finalPrompt = constructedPrompt;
    if (!finalPrompt) {
      finalPrompt = `Please audit the following text:\n"""\n${text}\n"""`;
    }

    // --- PROMPT OPTIMIZATION ---
    finalPrompt += `
\n*** IMPORTANT SYSTEM INSTRUCTIONS ***
1. Return ONLY valid JSON. **DO NOT** use Markdown formatting (no \`\`\`json).
2. "category" MUST be exactly one of: "language", "ai_logic", "brand", "product".
3. **DEDUPLICATION RULE:** Ensure each problematic text span is listed ONLY ONCE under the most relevant category (Product > Brand > Logic > Language).
4. **CITATION RULE:** For "language" and "ai_logic" issues, the 'citation' field MUST match the EXACT SOP Rule Label provided in the prompt (e.g., "Loại bỏ từ thừa"). Do not invent new citation names.
5. Limit to top 20 most critical issues.
6. **LANGUAGE:** All "reason" and "suggestion" fields must be in **Vietnamese**.
`;

    // Initialize Model
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash-exp',
      generationConfig: {
        temperature: 0.1, // Slight temp for creativity but low enough for structure
        topP: 0.95,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
        responseSchema: auditResponseSchema
      },
    });

    const result = await model.generateContent(finalPrompt);
    const responseText = result.response.text();

    // Parse Response
    let parsedResult = robustJSONParse(responseText);

    // Fallback if parsing completely fails
    if (!parsedResult) {
      console.warn("Audit JSON Parse Failed. Raw:", responseText.substring(0, 200));
      parsedResult = {
        summary: "Hệ thống không thể phân tích định dạng phản hồi từ AI. Dưới đây là dữ liệu thô.",
        identified_issues: [
          {
            category: "ai_logic",
            severity: "Low",
            problematic_text: "System Error",
            citation: "System",
            reason: "Invalid JSON Output from AI",
            suggestion: "Try simplifying the input text."
          }
        ]
      };
    }

    return res.status(200).json({
      success: true,
      result: parsedResult,
    });

  } catch (error) {
    console.error('Audit API Error:', error);

    let errorMessage = error.message || 'Unknown Error';
    if (errorMessage.includes('404')) {
      errorMessage = 'Model AI không phản hồi (404). Check Model ID.';
    } else if (errorMessage.includes('429')) {
      errorMessage = 'Hệ thống quá tải (Rate Limit). Thử lại sau 30s.';
    } else if (errorMessage.includes('SAFETY')) {
      errorMessage = 'Nội dung bị chặn bởi bộ lọc an toàn của Google.';
    }

    return res.status(200).json({
      success: true,
      result: {
        summary: 'Đã xảy ra lỗi hệ thống.',
        identified_issues: [
          {
            category: 'ai_logic',
            severity: 'High',
            problematic_text: 'API Error',
            citation: 'System',
            reason: errorMessage,
            suggestion: 'Vui lòng thử lại sau giây lát.',
          },
        ],
      },
    });
  }
}