
const fetch = require('node-fetch');

// --- HELPER: PROMPT TEMPLATES ---

function getLanguageInstructions(rules, language, platform, platformRules) {
  const targetLang =
    language === 'Vietnamese' ? 'vi' : language === 'English' ? 'en' : language === 'Japanese' ? 'ja' : language;

  const safeRules = Array.isArray(rules) ? rules : [];

  // Lấy các Rule thuộc nhóm Language từ Database
  const langRules = safeRules
    .filter((r) => {
      return (
        r.type === 'language' &&
        (!r.apply_to_language ||
          r.apply_to_language === 'all' ||
          r.apply_to_language === targetLang)
      );
    })
    .map((r) => `<Rule name="${r.label}">\n${r.content}\n</Rule>`)
    .join('\n');

  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LAYER 1: LANGUAGE & FORMATTING (NGÔN NGỮ & ĐỊNH DẠNG)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[DEFINITION]
Đây là lớp kiểm tra KỸ THUẬT. Chỉ quan tâm đến hình thức, không quan tâm đến ý nghĩa sâu xa.

[DATA SOURCE]
- SOP Rules (Type: Language)
- Platform Constraints (${platform})

[CHECKLIST BẮT BUỘC]
1. Chính tả & Ngữ pháp: Sai dấu hỏi/ngã, sai cấu trúc câu.
2. Typography (Lỗi trình bày):
   - [Space Error]: Dính chữ sau dấu câu hoặc thừa khoảng trắng trước dấu câu.
   - [Capitalization]: Viết hoa tùy tiện không đúng quy tắc.
3. Platform Standard (${platform}):
   - ${platformRules || 'Đảm bảo format phù hợp với kênh này.'}
4. SOP Compliance:
${langRules || '(Tuân thủ quy tắc ngữ pháp chuẩn)'}

[OUTPUT CATEGORY] -> "language"
`;
}

function getLogicInstructions(rules) {
  const safeRules = Array.isArray(rules) ? rules : [];
  
  const logicRulesFromSOP = safeRules
    .filter((r) => r.type === 'ai_logic')
    .map((r) => `<Rule name="${r.label}">\n${r.content}\n</Rule>`)
    .join('\n');

  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LAYER 2: AI LOGIC & REASONING (LOGIC & TƯ DUY)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[DEFINITION]
Đây là lớp kiểm tra TƯ DUY. Quan tâm đến tính hợp lý và sự nhất quán của nội dung.

[DATA SOURCE]
- SOP Rules (Type: AI Logic)
- Common Sense (Kiến thức phổ quát)

[CHECKLIST BẮT BUỘC]
1. Internal Consistency (Nhất quán nội tại):
   - Có đoạn nào mâu thuẫn với đoạn trước đó không? (VD: Đoạn 1 nói "Miễn phí", đoạn 3 nói "Giá 50k").
2. AI Hallucinations (Ảo giác):
   - Có thông tin nào nghe có vẻ bịa đặt, phi logic hoặc phóng đại quá mức không?
3. Reasoning Flow (Mạch lạc):
   - Lập luận có lủng củng, thiếu căn cứ không?

[SOP COMPLIANCE]
${logicRulesFromSOP || '<Rule name="Logic Check">Nội dung phải logic và nhất quán.</Rule>'}

[OUTPUT CATEGORY] -> "ai_logic"
`;
}

function getBrandInstructions(brand = {}) {
  const personality =
    (Array.isArray(brand.brand_personality) &&
      brand.brand_personality.join(', ')) ||
    brand.personality ||
    'Chưa xác định';

  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LAYER 3: BRAND IDENTITY (NHẬN DIỆN THƯƠNG HIỆU)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[DEFINITION]
Đây là lớp kiểm tra CẢM XÚC & BẢN SẮC. Quan tâm đến việc "Người nói là ai?".

[DATA SOURCE]
- Brand Profile (Object)

[CONTEXT]
- Brand Name: ${brand.name}
- Voice/Tone: ${brand.voice || brand.tone_of_voice || 'N/A'}
- Personality: ${personality}
- Do Words (Khuyên dùng): ${(Array.isArray(brand.do_words) && brand.do_words.join(', ')) || 'N/A'}
- Don't Words (CẤM DÙNG): ${(Array.isArray(brand.dont_words) && brand.dont_words.join(', ')) || 'N/A'}

[CHECKLIST BẮT BUỘC]
1. Voice Check: Văn bản có đúng giọng điệu (Tone) đã khai báo không?
2. Banned Words: Có xuất hiện từ nào trong danh sách "Don't Words" không? (Lỗi Nghiêm Trọng).
3. Personality Check: Văn bản có thể hiện đúng tính cách thương hiệu không?

[OUTPUT CATEGORY] -> "brand"
`;
}

function getProductInstructions(products) {
  const productList = Array.isArray(products)
    ? products
    : products
    ? [products]
    : [];

  let productContext = "Không có sản phẩm cụ thể được chọn. Chỉ kiểm tra lỗi logic sản phẩm chung chung.";
  
  if (productList.length > 0) {
    productContext = productList
      .map((p, index) => `
[ITEM ${index + 1}]
- Tên: ${p.name}
- Loại: ${p.type}
- Target Audience: ${p.target_audience}
- Benefits: ${p.benefits}
- USP (Unique Selling Point): ${p.usp}
`)
      .join('\n');
  }

  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LAYER 4: PRODUCT & MARKET FIT (SẢN PHẨM & THỊ TRƯỜNG)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[DEFINITION]
Đây là lớp kiểm tra SỰ THẬT SẢN PHẨM. Quan tâm đến tính chính xác của thông tin bán hàng.

[DATA SOURCE]
- Product Collection (Array)

[CONTEXT]
${productContext}

[CHECKLIST BẮT BUỘC]
1. Fact Check: Bài viết có nói sai tính năng/công dụng của sản phẩm so với dữ liệu cung cấp không?
2. USP Check: Bài viết có bỏ quên Lợi điểm bán hàng độc nhất (USP) không?
3. Audience Fit: Ngôn ngữ có phù hợp với "Target Audience" đã định nghĩa không?

[OUTPUT CATEGORY] -> "product"
`;
}

// Robust JSON parsing helper
function safeJSONParse(text) {
  try {
    let cleaned = text.trim();
    const markdownMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (markdownMatch) cleaned = markdownMatch[1];
    
    const firstOpen = cleaned.indexOf('{');
    const lastClose = cleaned.lastIndexOf('}');
    if (firstOpen !== -1 && lastClose !== -1) {
      cleaned = cleaned.substring(firstOpen, lastClose + 1);
      return JSON.parse(cleaned);
    }
    return JSON.parse(text);
  } catch (error) {
    console.warn("JSON Parse Error", error);
    throw error;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const {
      brand,
      text,
      platform,
      language,
      product,
      products,
      rules,
      platformRules,
    } = req.body;

    if (!brand || !text) {
      return res.status(400).json({ error: 'Brand and Text are required' });
    }

    const safeRules = Array.isArray(rules) ? rules : [];
    const targetProducts = products || product;

    const corePrompt = `
Bạn là Hệ thống MOODBIZ AI Auditor v10.0 (Spec-Compliant).
Nhiệm vụ: Audit văn bản dựa trên 4 Lớp tiêu chuẩn độc lập (Isolated Layers).

${getLanguageInstructions(safeRules, language, platform, platformRules)}
${getLogicInstructions(safeRules)}
${getBrandInstructions(brand)}
${getProductInstructions(targetProducts)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VĂN BẢN CẦN KIỂM DUYỆT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"${text}"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HƯỚNG DẪN XỬ LÝ (PROCESSING RULES)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. CLASSIFICATION (Phân loại):
   - Bắt buộc gán lỗi vào đúng 1 trong 4 category: "language", "ai_logic", "brand", "product".
   - Không được gán sai lớp (VD: Lỗi sai tính năng sản phẩm KHÔNG ĐƯỢC gán vào logic).

2. CITATION (Trích dẫn):
   - Nếu vi phạm Layer 1 hoặc 2: Trích dẫn tên thẻ <Rule name="...">.
   - Nếu vi phạm Layer 3: Ghi "Brand Guideline Violation".
   - Nếu vi phạm Layer 4: Ghi "Product Fact Violation".

3. NEGATIVE CONSTRAINTS (Chặn lỗi ảo):
   - Nếu văn bản đã tốt/đúng -> KHÔNG báo cáo.
   - KHÔNG đưa ra suggestion kiểu "Giữ nguyên" (Keep as is).
   - KHÔNG báo cáo trùng lặp (1 lỗi chỉ báo 1 lần).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT FORMAT (JSON ONLY)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{
  "summary": "Tóm tắt ngắn gọn tình trạng bài viết (Tiếng Việt).",
  "identified_issues": [
    {
      "category": "language | ai_logic | brand | product",
      "problematic_text": "Đoạn văn bị lỗi",
      "citation": "Nguồn quy tắc vi phạm",
      "reason": "Giải thích ngắn gọn tại sao lỗi",
      "severity": "High | Medium | Low",
      "suggestion": "Đề xuất sửa cụ thể (Khác với bản gốc)"
    }
  ]
}
`;

    const apiKey = process.env.GEMINI_API_KEY;
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`;

    const requestBody = {
      contents: [{ parts: [{ text: corePrompt }] }],
      generationConfig: {
        temperature: 0.1, // Cực thấp để đảm bảo tuân thủ Spec
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
      },
    };

    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    const data = await response.json();
    const textResult = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    let jsonResult;
    try {
      jsonResult = safeJSONParse(textResult);
      
      // Post-process: Lọc bỏ rác lần cuối tại server
      if (jsonResult.identified_issues && Array.isArray(jsonResult.identified_issues)) {
        jsonResult.identified_issues = jsonResult.identified_issues.filter(issue => {
           const suggestion = (issue.suggestion || '').toLowerCase();
           const prob = (issue.problematic_text || '').trim();
           const sugg = (issue.suggestion || '').trim();
           
           // Filter: Suggestion vô nghĩa
           if (suggestion.includes('giữ nguyên') || suggestion.includes('keep as is')) return false;
           // Filter: Suggestion y hệt bản gốc
           if (prob === sugg) return false;
           
           return true;
        });
      }

    } catch (parseErr) {
      console.error("JSON Parse Error:", parseErr);
      jsonResult = {
        summary: "Lỗi xử lý phản hồi từ AI.",
        identified_issues: [],
      };
    }

    return res.status(200).json({ result: jsonResult, success: true });
  } catch (e) {
    console.error("Audit API Error:", e);
    return res.status(500).json({ error: 'Server error', message: e.message });
  }
};
