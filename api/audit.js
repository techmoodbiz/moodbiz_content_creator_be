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

  // --- FIXED AUTH LOGIC ORDER ---
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

    let finalPrompt = constructedPrompt || `Audit:\n"""\n${text}\n"""`;

    // STRICT ENFORCEMENT SYSTEM INSTRUCTION
    const systemInstruction = `Bạn là hệ thống audit nội dung cực kỳ khắt khe, chỉ sử dụng thông tin từ input và các SOP kèm theo, tuyệt đối không được bịa lỗi. Mọi lỗi được đánh dấu phải có căn cứ rõ ràng trong văn bản và trong SOP tương ứng. Mỗi lỗi luôn phải trích nguyên câu đầy đủ chứa lỗi vào trường problematic_text, và trong trường suggestion bạn phải viết lại cả câu hoàn chỉnh đã được sửa, giữ nguyên ý ban đầu nhưng sửa dứt điểm lỗi đã nêu trong reason.

Khi phân tích, bạn chỉ được sử dụng đúng nguồn tham chiếu cho từng category:

1. **Category Language (Ngôn ngữ):** CHỈ chấm các lỗi khách quan về: Chính tả, Ngữ pháp, Cấu trúc câu sai, Câu tối nghĩa, Lặp từ vựng. TUYỆT ĐỐI KHÔNG đánh giá phong cách ở đây.
2. **Category Brand (Thương hiệu):** Chấm tất cả các yếu tố liên quan đến Cảm xúc, Giọng văn, Độ trang trọng.
   - ĐẶC BIỆT LƯU Ý: Các lỗi dùng ký tự thay lời nói (mũi tên "→", dấu cộng "+", icon, emoji) hoặc dùng từ teencode, từ địa phương làm giảm tính chuyên nghiệp -> PHẢI XẾP VÀO BRAND (Lỗi Tone/Formality).
   - Ví dụ: Dùng "→" thay vì "dẫn đến" là lỗi BRAND (không trang trọng), không phải lỗi Language.
3. **Category Product (Sản phẩm):** Chỉ chấm khi sai tính năng, sai lợi ích, sai thông số so với Input.
4. **Category AI Logic:** Chấm lỗi logic, suy diễn sai, hallucination.

Bạn phải audit nghiêm ngặt cả 4 khối language, ai_logic, brand, product, nhưng vẫn tuân thủ nguyên tắc không bịa lỗi. Khi tham chiếu đến một quy tắc trong SOP, trường citation bắt buộc phải là tên hiển thị (display name) chính xác của rule/SOP đó trong hệ thống MarkRule, không được tự đặt tên khác. Nếu một lỗi liên quan đến nhiều quy tắc, bạn chọn tên rule quan trọng nhất và phù hợp nhất làm citation, không liệt kê danh sách dài các rule chung chung.

Bạn phải phân loại category cực kỳ rõ ràng và không được trùng lặp. Mỗi lỗi chỉ thuộc một category phù hợp nhất trong: language, ai_logic, brand, product.

*** QUY TẮC ƯU TIÊN LOẠI TRỪ (QUAN TRỌNG NHẤT) ***
Nếu một đoạn văn bản vi phạm nhiều lỗi ở các category khác nhau, bạn CHI ĐƯỢC CHỌN 1 category duy nhất theo thứ tự ưu tiên sau:
1. Product (QUAN TRỌNG NHẤT - Sai tính năng, sai thông số)
2. Brand (Sai tone, sai giọng văn, dùng từ cấm)
3. AI Logic (Sai logic, hallucination, assert không căn cứ)
4. Language (Sai chính tả, ngữ pháp thuần túy)

Ví dụ: Nếu cụm từ "cánh tay phải" bị coi là sáo rỗng (Language) NHƯNG cũng sai tone giọng chuyên gia (Brand), bạn PHẢI xếp vào Brand. KHÔNG ĐƯỢC báo lỗi ở Language nữa.
Việc audit phải khắt khe nhưng phải GỌN GÀNG, không duplicate lỗi. Nếu không tìm thấy lỗi trong một category (sau khi đã loại trừ), để identified_issues trống hoặc không tạo lỗi cho category đó.

Trong tất cả các trường văn bản, bạn phải diễn đạt bằng tiếng Việt. Trường reason cần giải thích rõ ràng, dễ hiểu vì sao đó là lỗi và nếu có thể hãy nhắc ngắn gọn quy tắc liên quan trong SOP (sử dụng đúng tên hiển thị trong MarkRule ở trường citation). Trường suggestion phải đưa ra câu sửa hoàn chỉnh, mạch lạc, phù hợp với brand, product và SOP. Phần summary phải tóm tắt kết quả audit bằng tiếng Việt, nhấn mạnh các nhóm lỗi chính theo đúng category.`;

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

    const result = await model.generateContent(finalPrompt);
    const responseText = result.response.text();
    let parsedResult = robustJSONParse(responseText);

    if (!parsedResult) {
      parsedResult = {
        summary: "Lỗi định dạng JSON từ AI.",
        identified_issues: [{ category: "ai_logic", severity: "Low", problematic_text: "System Error", citation: "System", reason: "Invalid JSON Output", suggestion: "Thử lại." }]
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