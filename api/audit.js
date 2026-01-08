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
  const firstBrace = clean.indexOf('{');
  const lastBrace = clean.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1) {
    clean = clean.substring(firstBrace, lastBrace + 1);
  } else {
    return null;
  }
  try { return JSON.parse(clean); } catch (e) { }
  clean = clean.replace(/\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1').replace(/([{,]\s*)([a-zA-Z0-9_]+?)\s*:/g, '$1"$2":');
  try { return JSON.parse(clean); } catch (e) { }
  return null;
}

/**
 * FIX 3.1: Validation Layer - Check citation whitelist
 */
function validateAuditResult(result, allowedCitations) {
  const validatedIssues = [];
  const citationSet = new Set(allowedCitations.map(c => c.toLowerCase().trim()));

  if (!result.identified_issues || !Array.isArray(result.identified_issues)) {
    return { ...result, identified_issues: [] };
  }

  for (const issue of result.identified_issues) {
    // Check citation exists in whitelist
    const citationLower = (issue.citation || '').toLowerCase().trim();
    if (!citationSet.has(citationLower)) {
      console.warn(`Invalid citation detected and filtered: "${issue.citation}"`);
      continue; // Skip this issue - citation không hợp lệ
    }

    // Check category is valid
    const validCategories = ['language', 'brand', 'product', 'ai_logic'];
    if (!validCategories.includes(issue.category)) {
      console.warn(`Invalid category detected: "${issue.category}"`);
      continue;
    }

    // Check required fields
    if (!issue.problematic_text || !issue.reason || !issue.suggestion) {
      console.warn(`Incomplete issue detected, skipping`);
      continue;
    }

    validatedIssues.push(issue);
  }

  return { ...result, identified_issues: validatedIssues };
}

/**
 * FIX 3.1: Check for duplicate categories (waterfall violation)
 */
function checkWaterfallCompliance(issues) {
  const problemTexts = new Map(); // Track problematic_text -> categories

  for (const issue of issues) {
    const key = issue.problematic_text.trim().toLowerCase();
    if (problemTexts.has(key)) {
      problemTexts.get(key).push(issue.category);
    } else {
      problemTexts.set(key, [issue.category]);
    }
  }

  // Log warnings for violations
  for (const [text, categories] of problemTexts.entries()) {
    if (categories.length > 1) {
      console.warn(`Waterfall violation: Same text flagged in multiple categories: ${categories.join(', ')}`);
      console.warn(`Text: ${text.substring(0, 50)}...`);
    }
  }
}

/**
 * FIX 3.2: Calculate prompt token estimate (rough approximation)
 */
function estimateTokens(text) {
  // Rough estimate: 1 token ≈ 4 characters for Vietnamese/English mix
  return Math.ceil(text.length / 4);
}

/**
 * FIX 3.7: Log audit history to Firestore
 */
async function logAuditHistory(data) {
  try {
    const db = admin.firestore();
    await db.collection('audit_history').add({
      ...data,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (error) {
    console.error('Failed to log audit history:', error);
    // Don't throw - logging failure shouldn't break audit
  }
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
  let decodedToken;

  try {
    decodedToken = await admin.auth().verifyIdToken(token);
  } catch (error) {
    console.error("Token verification failed:", error);
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }

  // FIX 3.6: Proper error handling with different status codes
  try {
    const { constructedPrompt, text, citationWhitelist = [], brandId, productId } = req.body;

    // Validate input
    if (!text || text.trim().length === 0) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Text to audit is required'
      });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('Missing GEMINI_API_KEY');
      return res.status(500).json({
        error: 'Configuration Error',
        message: 'API key not configured'
      });
    }

    // FIX 3.2: Monitor prompt length
    const promptTokens = estimateTokens(constructedPrompt || text);
    const textTokens = estimateTokens(text);
    const totalEstimatedTokens = promptTokens + textTokens;

    console.log(`Token estimate - Prompt: ${promptTokens}, Text: ${textTokens}, Total: ${totalEstimatedTokens}`);

    // FIX 3.2: Warn if prompt is too long
    if (totalEstimatedTokens > 30000) {
      console.warn(`⚠️ Prompt exceeds recommended length: ${totalEstimatedTokens} tokens`);
      return res.status(400).json({
        error: 'Request Too Large',
        message: `Input text is too long (estimated ${totalEstimatedTokens} tokens). Please reduce text length or simplify rules.`,
        estimated_tokens: totalEstimatedTokens
      });
    }

    const { GoogleGenerativeAI, SchemaType } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);

    // FIX 3.3: Add confidence score to schema
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
                description: "One of: language, ai_logic, brand, product",
                enum: ["language", "ai_logic", "brand", "product"]
              },
              problematic_text: {
                type: SchemaType.STRING,
                description: "Full sentence containing error"
              },
              citation: {
                type: SchemaType.STRING,
                description: "Exact Rule Label from Source - MUST match whitelist"
              },
              reason: {
                type: SchemaType.STRING,
                description: "Explanation in Vietnamese"
              },
              severity: {
                type: SchemaType.STRING,
                enum: ["High", "Medium", "Low"]
              },
              suggestion: {
                type: SchemaType.STRING,
                description: "Complete rewritten sentence in Vietnamese"
              },
              confidence: {
                type: SchemaType.NUMBER,
                description: "Confidence score 0.0-1.0 indicating how certain the model is about this issue"
              }
            },
            required: ["category", "problematic_text", "reason", "suggestion", "citation", "confidence"]
          }
        }
      },
      required: ["summary", "identified_issues"]
    };

    const systemInstruction = `
Bạn là hệ thống audit nội dung cực kỳ khắt khe. Bạn CHỈ được sử dụng thông tin trong:
- Văn bản cần chấm (input text).
- Các SOP/MarkRule được cung cấp trong prompt (Language, Brand, Product, AI Logic).

**QUY TẮC VÀNG - NO HALLUCINATION:**
TUYỆT ĐỐI KHÔNG được sử dụng bất kỳ kiến thức, quy tắc hay "best practice" nào khác ngoài SOP đi kèm. 
Không được tự tạo thêm quy tắc mới, không được suy diễn dựa trên kinh nghiệm hay kiến thức bên ngoài. 
Nếu một câu KHÔNG vi phạm SOP nào thì PHẢI coi là ĐÚNG, dù bạn nghĩ có cách viết "hay hơn".

**BRAND PERSONALITY & VOICE LÀ IMPLICIT RULES:**
Brand personality (Professional, Friendly, Expert) và Brand voice (Formal, Casual, Inspiring) là các quy tắc ngầm định hợp lệ.
Ví dụ: Nếu Brand personality = "Professional" và Brand voice = "Formal", việc dùng emoji, teencode, ký hiệu "→" là vi phạm brand.
Bạn không cần SOP riêng cho từng aspect - personality và voice chính là source of truth.

Mọi lỗi được đánh dấu phải có căn cứ rõ ràng trong văn bản và trong đúng SOP tương ứng. 
Mỗi lỗi luôn phải trích NGUYÊN CÂU đầy đủ chứa lỗi vào trường "problematic_text". 
Trong trường "suggestion", bạn phải viết lại CẢ CÂU hoàn chỉnh đã được sửa, giữ nguyên ý ban đầu nhưng sửa dứt điểm lỗi đã nêu trong "reason".

**PHÂN LOẠI CATEGORY CỰC KỲ RÕ RÀNG:**

1. Category "language" (Ngôn ngữ - CHỈ LỖI KHÁCH QUAN):
   - Chỉ chấm các lỗi khách quan về: chính tả, ngữ pháp, cấu trúc câu sai, câu tối nghĩa, lặp từ.
   - TUYỆT ĐỐI KHÔNG đánh giá phong cách, cảm xúc, giọng văn, mức độ trang trọng.

2. Category "brand" (Thương hiệu - TẤT CẢ VỀ CẢM XÚC & HÌNH ẢNH):
   - Chấm tất cả yếu tố liên quan đến cảm xúc, giọng văn, độ trang trọng, tone of voice và sự phù hợp với hình ảnh thương hiệu.
   - Các lỗi dùng ký tự thay lời nói (mũi tên "→", dấu "+", icon, emoji), dùng teencode, từ địa phương, từ xuồng xã làm giảm tính chuyên nghiệp đều PHẢI xếp vào "brand" (lỗi Tone/Formality).

3. Category "product" (Sản phẩm - CHỈ SAI THÔNG TIN THỰC TẾ):
   - Chỉ chấm khi có thông tin sản phẩm trong input.
   - Chỉ đánh dấu lỗi khi sai tính năng, sai lợi ích, sai thông số, sai claim so với thông tin sản phẩm/SOP được cung cấp.

4. Category "ai_logic" (Logic & Suy diễn):
   - Chấm lỗi logic, suy diễn sai, mâu thuẫn nội bộ, hallucination, khẳng định không có căn cứ.

**QUY TẮC ƯU TIÊN LOẠI TRỪ - WATERFALL DEDUPLICATION:**
Nếu một đoạn văn bản vi phạm nhiều lỗi ở các category khác nhau, bạn CHỈ ĐƯỢC CHỌN 1 category duy nhất theo thứ tự ưu tiên:
1. "product" → 2. "brand" → 3. "ai_logic" → 4. "language"

TUYỆT ĐỐI KHÔNG báo cùng một đoạn text ở nhiều category.

**CONFIDENCE SCORE (BẮT BUỘC):**
Với mỗi lỗi, bạn phải đánh giá độ tin cậy của mình (0.0 - 1.0):
- 0.9-1.0: Rất chắc chắn (sai chính tả rõ ràng, vi phạm forbidden word trực tiếp)
- 0.7-0.89: Tương đối chắc (vi phạm tone, logic không rõ ràng)
- 0.5-0.69: Không chắc lắm (có thể là lỗi, cần review)
- < 0.5: Không nên báo lỗi này

**CITATION (TRÍCH NGUỒN) BẮT BUỘC:**
Trường "citation" BẮT BUỘC phải là tên hiển thị chính xác của rule/SOP trong hệ thống.
Nếu một lỗi không tìm được rule/SOP tương ứng, thì KHÔNG ĐƯỢC tạo lỗi đó.

**OUTPUT FORMAT:**
- "reason": Giải thích bằng tiếng Việt vì sao đó là lỗi.
- "suggestion": Viết lại CẢ CÂU hoàn chỉnh đã được sửa.
- "problematic_text": NGUYÊN CÂU đầy đủ chứa lỗi.
- "confidence": Số thập phân từ 0.0 đến 1.0.
- "summary": Tóm tắt kết quả audit bằng tiếng Việt.
`;

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash-exp',
      systemInstruction: systemInstruction,
      generationConfig: {
        temperature: 0.1,
        topP: 0.95,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
        responseSchema: auditResponseSchema
      },
    });

    const finalPrompt = constructedPrompt || `Audit this text:\n"""\n${text}\n"""`;

    const startTime = Date.now();
    const result = await model.generateContent(finalPrompt);
    const latency = Date.now() - startTime;

    const responseText = result.response.text();
    let parsedResult = robustJSONParse(responseText);

    if (!parsedResult) {
      console.error('Failed to parse AI response');
      return res.status(500).json({
        error: 'AI Response Error',
        message: 'Failed to parse AI response. Please try again.'
      });
    }

    // FIX 3.1: Validate result with citation whitelist
    const defaultCitations = [
      'Brand Voice', 'Brand Personality', 'Forbidden Words',
      'Product Accuracy', 'Product Claim', 'Grammar/Spelling',
      'General Logic', 'System'
    ];
    const allCitations = [...defaultCitations, ...(citationWhitelist || [])];
    parsedResult = validateAuditResult(parsedResult, allCitations);

    // FIX 3.1: Check waterfall compliance
    checkWaterfallCompliance(parsedResult.identified_issues);

    // FIX 3.7: Log audit history
    await logAuditHistory({
      user_id: decodedToken.uid,
      brand_id: brandId,
      product_id: productId,
      text_length: text.length,
      estimated_tokens: totalEstimatedTokens,
      issues_found: parsedResult.identified_issues.length,
      latency_ms: latency,
      model: 'gemini-2.0-flash-exp'
    });

    // FIX 3.6: Return proper success response with metadata
    return res.status(200).json({
      success: true,
      result: parsedResult,
      metadata: {
        latency_ms: latency,
        estimated_tokens: totalEstimatedTokens,
        issues_count: parsedResult.identified_issues.length,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Audit API Error:', error);

    // FIX 3.6: Return 500 for system errors
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'An error occurred during audit. Please try again later.',
      // Don't expose internal error details to client in production
      ...(process.env.NODE_ENV === 'development' && { details: error.message })
    });
  }
}