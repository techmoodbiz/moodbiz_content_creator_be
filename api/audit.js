
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
 */
function robustJSONParse(text) {
  if (!text) return null;
  let clean = String(text);
  // Remove markdown code blocks if present
  clean = clean.replace(/```json/gi, '').replace(/```/g, '').trim();

  const firstBrace = clean.indexOf('{');
  const lastBrace = clean.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1) {
    clean = clean.substring(firstBrace, lastBrace + 1);
  } else {
    return null;
  }
  try { return JSON.parse(clean); } catch (e) { }
  // Try cleaning common errors
  clean = clean.replace(/\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1').replace(/([{,]\s*)([a-zA-Z0-9_]+?)\s*:/g, '$1"$2":');
  try { return JSON.parse(clean); } catch (e) { }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // --- AUTH VERIFICATION ---
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token format' });
  }

  const parts = authHeader.split('Bearer ');
  if (parts.length < 2) {
    return res.status(401).json({ error: 'Unauthorized: Malformed token' });
  }

  const token = parts[1].trim();

  try {
    await admin.auth().verifyIdToken(token);
  } catch (error) {
    console.error("Token verification failed:", error);
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }

  try {
    const { constructedPrompt, text } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('Missing API Key');

    const { GoogleGenerativeAI, SchemaType } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);

    const auditResponseSchema = {
      type: SchemaType.OBJECT,
      properties: {
        summary: { type: SchemaType.STRING },
        identified_issues: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              category: { type: SchemaType.STRING, description: "One of: language, ai_logic, brand, product" },
              problematic_text: { type: SchemaType.STRING, description: "Full sentence containing error" },
              citation: { type: SchemaType.STRING, description: "Exact Rule Label from Whitelist" },
              reason: { type: SchemaType.STRING, description: "Explanation in Vietnamese" },
              severity: { type: SchemaType.STRING, description: "High, Medium, Low" },
              suggestion: { type: SchemaType.STRING, description: "Complete rewritten sentence in Vietnamese" }
            },
            required: ["category", "problematic_text", "reason", "suggestion", "citation", "severity"]
          }
        }
      },
      required: ["summary", "identified_issues"]
    };

    // STRICT SYSTEM INSTRUCTION TO FORCE WATERFALL PRIORITY
    const systemInstruction = `
You are MOODBIZ SUPREME AUDITOR.

**CORE DIRECTIVE:**
You must audit the text using a strict "Waterfall Priority" mechanism. You have 4 layers of checks.
You must prioritize reporting High-Level violations (Product/Brand) over Low-Level violations (Language).

**PRIORITY LEVELS (Highest to Lowest):**
1. **PRODUCT:** Factually wrong, missing USP, wrong specs. (Category: "product")
2. **BRAND:** Wrong tone, forbidden words, unprofessional style. (Category: "brand")
3. **LOGIC:** Contradictions, hallucinations. (Category: "ai_logic")
4. **LANGUAGE:** Spelling, grammar. (Category: "language")

**RULE:** If a sentence has a Brand Error (e.g., using "→" which is informal) AND a grammar error, you MUST report it as a BRAND error. Do not report it as a Language error.

**CITATION:**
You must strictly use the Citation String from the provided Whitelist in the user prompt. Do not invent new citation names.

**OUTPUT:**
Return valid JSON adhering to the schema. All strings in Vietnamese.
`;

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash-exp', // Use 2.0 Flash Exp for reliable JSON & Reasoning
      systemInstruction: systemInstruction,
      generationConfig: {
        temperature: 0.1, // Low temperature for consistent auditing
        topP: 0.95,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
        responseSchema: auditResponseSchema
      },
    });

    const finalPrompt = constructedPrompt || `Audit this text:\n"""\n${text}\n"""`;

    const result = await model.generateContent(finalPrompt);
    const responseText = result.response.text();
    let parsedResult = robustJSONParse(responseText);

    if (!parsedResult) {
      console.warn("Audit JSON parse failed, raw:", responseText);
      parsedResult = {
        summary: "Lỗi định dạng JSON từ AI. Vui lòng thử lại.",
        identified_issues: [{ category: "ai_logic", severity: "Low", problematic_text: "System Error", citation: "System", reason: "Invalid JSON Output from AI", suggestion: "Thử lại." }]
      };
    }

    return res.status(200).json({ success: true, result: parsedResult });

  } catch (error) {
    console.error('Audit API Error:', error);
    return res.status(200).json({
      success: true,
      result: {
        summary: 'Lỗi hệ thống khi phân tích.',
        identified_issues: [{ category: 'ai_logic', severity: 'High', problematic_text: 'API Error', citation: 'System', reason: error.message, suggestion: 'Thử lại sau.' }],
      },
    });
  }
}
