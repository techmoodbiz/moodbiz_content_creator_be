
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
 * Robust JSON Parser that attempts to fix common LLM JSON errors
 * including markdown blocks, trailing commas, and truncation.
 */
function robustJSONParse(text) {
  if (!text) return null;

  let clean = String(text).trim();

  // 1. Strip Markdown
  clean = clean.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');

  // 2. Remove comments
  clean = clean.replace(/\/\/.*$/gm, '');

  // 3. Attempt direct parse
  try {
    return JSON.parse(clean);
  } catch (e) {
    // Continue to repair strategies
  }

  // 4. Fix trailing commas (common error)
  clean = clean.replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(clean);
  } catch (e) { }

  // 5. Fix missing commas between objects (e.g. }{ )
  clean = clean.replace(/}\s*{/g, '},{');
  try {
    return JSON.parse(clean);
  } catch (e) { }

  // 6. Handle Truncated JSON (The "Audit sai/lỗi format" often comes from max token truncation)
  // We assume the structure is { summary: "...", identified_issues: [ ... ] }
  // We try to find the last valid object closing '}' inside the array and close the structure.
  try {
    const issuesStart = clean.indexOf('"identified_issues"');
    if (issuesStart !== -1) {
      const arrayStart = clean.indexOf('[', issuesStart);
      if (arrayStart !== -1) {
        // Find the last '}' that likely closes an issue object
        const lastObjectClose = clean.lastIndexOf('}');
        if (lastObjectClose > arrayStart) {
          // Construct a valid sub-string
          // This is a heuristic: take everything up to the last '}', add ']}'
          let recovered = clean.substring(0, lastObjectClose + 1);

          // Count braces to see if we need to close the array and root object
          const openBraces = (recovered.match(/{/g) || []).length;
          const closeBraces = (recovered.match(/}/g) || []).length;
          const openBrackets = (recovered.match(/\[/g) || []).length;
          const closeBrackets = (recovered.match(/\]/g) || []).length;

          if (openBrackets > closeBrackets) recovered += ']';
          if (openBraces > closeBraces) recovered += '}';

          return JSON.parse(recovered);
        }
      }
    }
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

    // --- STRICT SCHEMA CONFIGURATION ---
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
                enum: ["language", "ai_logic", "brand", "product"]
              },
              problematic_text: { type: SchemaType.STRING },
              citation: { type: SchemaType.STRING },
              reason: { type: SchemaType.STRING },
              severity: { type: SchemaType.STRING, enum: ["High", "Medium", "Low"] },
              suggestion: { type: SchemaType.STRING }
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

    // --- PROMPT OPTIMIZATION ---
    // Explicitly enforce the 4 blocks and concise output to avoid truncation
    finalPrompt += `
\n*** SYSTEM INSTRUCTIONS ***
1. Analyze the text strictly according to the 4 BLOCKS provided (Language, AI Logic, Brand, Product).
2. Output PURE JSON matching the provided schema.
3. "category" MUST be one of: "language", "ai_logic", "brand", "product".
4. BE EXTREMELY CRITICAL. Do not overlook minor issues. Scrutinize every sentence.
5. Keep "reason" and "suggestion" concise (Vietnamese).
6. Prioritize HIGH severity issues first.
7. Limit the output to the top 20 most critical issues to ensure the JSON is complete and valid.
1. Analyze the text strictly according to the 4 BLOCKS provided.
2. IF A BLOCK IS MARKED "BYPASSED", DO NOT GENERATE ISSUES FOR THAT CATEGORY.
3. Output PURE JSON matching the provided schema.
4. "category" MUST be one of: "language", "ai_logic", "brand", "product".
5. BE EXTREMELY CRITICAL. Do not overlook minor issues. Scrutinize every sentence.
6. Keep "reason" and "suggestion" concise (Vietnamese).
7. Prioritize HIGH severity issues first.
8. Limit the output to the top 20 most critical issues to ensure the JSON is complete and valid.
`;

    // Initialize Model
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash-exp', // Using experimental model for better schema adherence
      generationConfig: {
        temperature: 0.0, // Deterministic for structured data
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
            reason: "Invalid JSON Output",
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

    // Check for specific Gemini errors
    let errorMessage = error.message || 'Unknown Error';
    if (errorMessage.includes('404')) {
      errorMessage = 'Model AI không phản hồi (404). Vui lòng liên hệ Admin kiểm tra cấu hình Model ID.';
    } else if (errorMessage.includes('429')) {
      errorMessage = 'Hệ thống đang quá tải (Rate Limit). Vui lòng thử lại sau 30s.';
    }

    return res.status(200).json({
      success: true, // Return 200 to frontend but with error result structure
      result: {
        summary: 'Đã xảy ra lỗi trong quá trình xử lý.',
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