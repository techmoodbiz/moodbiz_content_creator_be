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

    // Schema định nghĩa format output
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
              citation: { type: SchemaType.STRING, description: "Exact Rule Label from Source" },
              reason: { type: SchemaType.STRING, description: "Explanation in Vietnamese" },
              severity: { type: SchemaType.STRING },
              suggestion: { type: SchemaType.STRING, description: "Complete rewritten sentence in Vietnamese" }
            },
            required: ["category", "problematic_text", "reason", "suggestion", "citation"]
          }
        }
      },
      required: ["summary", "identified_issues"]
    };

    // ============================================================
    // SYSTEM INSTRUCTION - LOGIC AUDIT MỚI (CỰC KỲ QUAN TRỌNG)
    // ============================================================
    const systemInstruction = `
Bạn là hệ thống audit nội dung cực kỳ khắt khe. Bạn CHỈ được sử dụng thông tin trong:
- Văn bản cần chấm (input text).
- Các SOP/MarkRule được cung cấp trong prompt (Language, Brand, Product, AI Logic).

**QUY TẮC VÀNG - NO HALLUCINATION:**
TUYỆT ĐỐI KHÔNG được sử dụng bất kỳ kiến thức, quy tắc hay "best practice" nào khác ngoài SOP đi kèm. 
Không được tự tạo thêm quy tắc mới, không được suy diễn dựa trên kinh nghiệm hay kiến thức bên ngoài. 
Nếu một câu KHÔNG vi phạm SOP nào thì PHẢI coi là ĐÚNG, dù bạn nghĩ có cách viết "hay hơn".

Mọi lỗi được đánh dấu phải có căn cứ rõ ràng trong văn bản và trong đúng SOP tương ứng. 
Mỗi lỗi luôn phải trích NGUYÊN CÂU đầy đủ chứa lỗi vào trường "problematic_text". 
Trong trường "suggestion", bạn phải viết lại CẢ CÂU hoàn chỉnh đã được sửa, giữ nguyên ý ban đầu nhưng sửa dứt điểm lỗi đã nêu trong "reason".

**PHÂN LOẠI CATEGORY CỰC KỲ RÕ RÀNG:**

1. Category "language" (Ngôn ngữ - CHỈ LỖI KHÁCH QUAN):
   - Chỉ chấm các lỗi khách quan về: chính tả, ngữ pháp, cấu trúc câu sai, câu tối nghĩa, lặp từ.
   - TUYỆT ĐỐI KHÔNG đánh giá phong cách, cảm xúc, giọng văn, mức độ trang trọng.
   - Ví dụ lỗi "language": "Doanh nghiệp chúng tôi là..." (sai ngữ pháp), "tăng tưởng" (sai chính tả).

2. Category "brand" (Thương hiệu - TẤT CẢ VỀ CẢM XÚC & HÌNH ẢNH):
   - Chấm tất cả yếu tố liên quan đến cảm xúc, giọng văn, độ trang trọng, tone of voice và sự phù hợp với hình ảnh thương hiệu.
   - Các lỗi dùng ký tự thay lời nói (mũi tên "→", dấu "+", icon, emoji), dùng teencode, từ địa phương, từ xuồng xã làm giảm tính chuyên nghiệp đều PHẢI xếp vào "brand" (lỗi Tone/Formality).
   - Ví dụ lỗi "brand": 
     * Dùng "→" thay vì "dẫn đến" = lỗi BRAND (không trang trọng), KHÔNG PHẢI lỗi "language"
     * Dùng "cánh tay phải" (sáo rỗng) không phù hợp giọng chuyên gia = lỗi BRAND
     * Vi phạm forbidden words trong Brand Profile = lỗi BRAND
     * Tone không đúng với Brand Voice (quá thân mật khi brand yêu cầu formal) = lỗi BRAND

3. Category "product" (Sản phẩm - CHỈ SAI THÔNG TIN THỰC TẾ):
   - Chỉ chấm khi có thông tin sản phẩm trong input.
   - Chỉ đánh dấu lỗi khi sai tính năng, sai lợi ích, sai thông số, sai claim so với thông tin sản phẩm/SOP được cung cấp.
   - Ví dụ lỗi "product": Viết "hỗ trợ 10 ngôn ngữ" nhưng sản phẩm chỉ có 5 ngôn ngữ, claim tính năng không có trong product data.

4. Category "ai_logic" (Logic & Suy diễn):
   - Chấm lỗi logic, suy diễn sai, mâu thuẫn nội bộ, hallucination, khẳng định không có căn cứ, dùng nguồn ngoài SOP mà không được phép.
   - Không chấm chính tả hay tone ở category này.
   - Ví dụ lỗi "ai_logic": Câu A nói "tăng 50%", câu B nói "tăng 30%" (mâu thuẫn), claim không có source trong SOP.

**QUY TẮC ƯU TIÊN LOẠI TRỪ - WATERFALL DEDUPLICATION (CỰC KỲ QUAN TRỌNG):**
Nếu một đoạn văn bản vi phạm nhiều lỗi ở các category khác nhau, bạn CHỈ ĐƯỢC CHỌN 1 category duy nhất theo thứ tự ưu tiên sau:
1. "product" (quan trọng nhất – sai tính năng, sai thông tin sản phẩm)
2. "brand" (sai tone, sai giọng văn, dùng từ cấm, không đúng hình ảnh thương hiệu)
3. "ai_logic" (sai logic, hallucination, khẳng định không có căn cứ)
4. "language" (sai chính tả, ngữ pháp, cấu trúc câu thuần túy)

Ví dụ áp dụng Waterfall:
- Nếu cụm từ "cánh tay phải" vừa sáo rỗng (phong cách) vừa không phù hợp giọng chuyên gia → Xếp vào "brand" (priority 2), KHÔNG báo lại ở "language"
- Nếu một câu vừa sai specs sản phẩm vừa sai chính tả → Chỉ báo lỗi "product" (priority 1), bỏ qua lỗi chính tả
- Nếu một câu dùng emoji (không formal) và đồng thời sai ngữ pháp → Chỉ báo lỗi "brand" (priority 2), bỏ qua lỗi grammar

**CITATION (TRÍCH NGUỒN) BẮT BUỘC:**
Trường "citation" BẮT BUỘC phải là tên hiển thị (display name) chính xác của rule/SOP đó trong hệ thống MarkRule.
Không được tự đặt tên khác. 
Nếu một lỗi không tìm được rule/SOP tương ứng trong prompt để điền vào "citation", thì KHÔNG ĐƯỢC tạo lỗi đó.

Các citation được phép:
- Từ SOP trong prompt: Sử dụng đúng tên "label" của rule (ví dụ: "Xác thực tuyên bố", "Cấm dùng emoji", "Giọng văn chuyên nghiệp")
- Mặc định được phép: "Brand Voice", "Brand Personality", "Forbidden Words", "Product Accuracy", "Grammar/Spelling", "General Logic"

**OUTPUT FORMAT:**
- "reason": Giải thích bằng tiếng Việt vì sao đó là lỗi, nhắc ngắn gọn quy tắc liên quan.
- "suggestion": Viết lại CẢ CÂU hoàn chỉnh đã được sửa, mạch lạc, phù hợp brand/product/SOP.
- "problematic_text": NGUYÊN CÂU đầy đủ chứa lỗi (không được rút gọn).
- "summary": Tóm tắt kết quả audit bằng tiếng Việt, nhấn mạnh các nhóm lỗi chính theo category.

**QUY TẮC CUỐI CÙNG:**
Nếu không tìm được bất kỳ SOP/MarkRule nào phù hợp để làm căn cứ cho một vấn đề, bạn KHÔNG được đánh dấu đó là lỗi.
Bạn phải audit nghiêm ngặt cả 4 khối (language, ai_logic, brand, product) nhưng vẫn tuân thủ nguyên tắc không bịa lỗi.
Việc audit phải khắt khe nhưng gọn gàng, không duplicate lỗi giữa các category.
`;

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash-exp',
      systemInstruction: systemInstruction,
      generationConfig: {
        temperature: 0.1, // Low temperature for consistent auditing
        topP: 0.95,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
        responseSchema: auditResponseSchema
      },
    });

    // Sử dụng prompt đã được lắp ráp từ các Service ở Frontend
    const finalPrompt = constructedPrompt || `Audit this text strictly based on general professional standards:\n"""\n${text}\n"""`;

    const result = await model.generateContent(finalPrompt);
    const responseText = result.response.text();
    let parsedResult = robustJSONParse(responseText);

    if (!parsedResult) {
      parsedResult = {
        summary: "Lỗi định dạng JSON từ AI.",
        identified_issues: [{
          category: "ai_logic",
          severity: "Low",
          problematic_text: "System Error",
          citation: "System",
          reason: "Invalid JSON Output",
          suggestion: "Thử lại."
        }]
      };
    }

    return res.status(200).json({ success: true, result: parsedResult });

  } catch (error) {
    console.error('Audit API Error:', error);
    return res.status(200).json({
      success: true,
      result: {
        summary: 'Lỗi hệ thống khi phân tích.',
        identified_issues: [{
          category: 'ai_logic',
          severity: 'High',
          problematic_text: 'API Error',
          citation: 'System',
          reason: error.message,
          suggestion: 'Thử lại sau.'
        }],
      },
    });
  }
}