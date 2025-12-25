
const fetch = require('node-fetch');

// --- HELPER: PROMPT TEMPLATES ---

function getLanguageInstructions(rules, language, platform, platformRules) {
  const targetLang =
    language === 'Vietnamese' ? 'vi' : language === 'English' ? 'en' : language === 'Japanese' ? 'ja' : language;

  const safeRules = Array.isArray(rules) ? rules : [];

  const langRules = safeRules
    .filter((r) => {
      return (
        r.type === 'language' &&
        (!r.apply_to_language ||
          r.apply_to_language === 'all' ||
          r.apply_to_language === targetLang)
      );
    })
    .map((r) => `- [SOP RULE: ${r.label}]: ${r.content}`)
    .join('\n');

  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LAYER 1: LANGUAGE & FORMATTING (NGÔN NGỮ & ĐỊNH DẠNG)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHẠM VI (SCOPE): Category "language".
NHIỆM VỤ: Bạn là "Grammar Nazi" (Cảnh sát chính tả). Hãy bắt TẤT CẢ các lỗi liên quan đến hình thức văn bản.

1. KIỂM TRA LỖI DÍNH CHỮ & KHOẢNG TRẮNG (BẮT BUỘC):
  Bạn phải soi từng ký tự. Nếu thấy lỗi sau, hãy FLAG ngay vào category "language":
  - [LỖI DÍNH CHỮ]: Thiếu khoảng trắng SAU dấu câu (, . ; : …).
    + Ví dụ SAI: "link,…Các", "abc,def", "hết câu.Bắt đầu".
    + Ví dụ ĐÚNG: "link,… Các", "abc, def", "hết câu. Bắt đầu".
  - [LỖI THỪA KHOẢNG TRẮNG]: Có khoảng trắng TRƯỚC dấu câu.
    + Ví dụ SAI: "kết thúc .", "liên kết ,".
    + Ví dụ ĐÚNG: "kết thúc.", "liên kết,".

2. CÁC LỖI NGÔN NGỮ KHÁC:
  - Chính tả (Spelling/Typos).
  - Ngữ pháp (Grammar).
  - Viết hoa tùy tiện (Capitalization).

3. PLATFORM COMPLIANCE (CHUẨN KÊNH ${String(platform || '').toUpperCase()}):
  - ${platformRules || 'Tuân thủ định dạng chuẩn, độ dài và văn phong phù hợp với hành vi đọc trên kênh này.'}

Ngôn ngữ mục tiêu: ${language || 'Không xác định'}
Quy chuẩn SOP bổ sung:
${langRules || '- (Không có quy chuẩn ngôn ngữ bổ sung được cung cấp.)'}
`;
}

function getLogicInstructions(rules) {
  const safeRules = Array.isArray(rules) ? rules : [];
  
  const logicRulesFromSOP = safeRules
    .filter((r) => r.type === 'ai_logic')
    .map((r) => `- [SOP RULE: ${r.label}]: ${r.content}`)
    .join('\n');

  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LAYER 2: AI LOGIC & ACCURACY (LOGIC & SỰ THẬT)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHẠM VI (SCOPE): Category "ai_logic".
QUAN TRỌNG (NEGATIVE CONSTRAINT): KHÔNG ĐƯỢC báo cáo lỗi chính tả, dấu câu hay ngữ pháp ở đây. Nếu thấy lỗi chính tả, hãy đưa nó về Layer 1 (Language).

NHIỆM VỤ:
- Phát hiện Hallucinations (Ảo giác AI): Các thông tin, số liệu bịa đặt không có trong văn bản gốc.
- Phát hiện Contradictions (Mâu thuẫn): Đoạn trước đá đoạn sau.
- Phát hiện Lỗi Lập luận (Reasoning): Kết luận không logic.

Quy chuẩn SOP Logic:
${logicRulesFromSOP || '- [SOP RULE: INTERNAL-CONSISTENCY]: Đánh dấu lỗi khi hai đoạn trong cùng bài tự mâu thuẫn nhau.'}
`;
}

function getBrandInstructions(brand = {}, rules) {
  const safeRules = Array.isArray(rules) ? rules : [];

  const brandRules = safeRules
    .filter((r) => r.type === 'brand')
    .map((r) => `- [SOP ${r.label}]: ${r.content}`)
    .join('\n');

  const personality =
    (Array.isArray(brand.brand_personality) &&
      brand.brand_personality.join(', ')) ||
    brand.personality ||
    'Chưa xác định';

  const doWords =
    (Array.isArray(brand.do_words) && brand.do_words.join(', ')) ||
    'Không có';

  const dontWords =
    (Array.isArray(brand.dont_words) && brand.dont_words.join(', ')) ||
    'Không có';

  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LAYER 3: BRAND IDENTITY (THƯƠNG HIỆU - LINH HỒN BÀI VIẾT)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHẠM VI (SCOPE): Category "brand".

Dữ liệu Brand:
1. [VOICE/TONE]: ${brand.voice || brand.tone_of_voice || 'Chưa xác định'}
2. [PERSONALITY]: ${personality}
3. [DO WORDS]: ${doWords}
4. [DON'T WORDS]: ${dontWords}

Quy chuẩn SOP bổ sung:
${brandRules || '- Tuyệt đối trung thành với bản sắc thương hiệu.'}

NHIỆM VỤ:
- Kiểm tra xem văn phong có đúng "chất" của ${brand.name || 'thương hiệu'} không.
- Kiểm tra nghiêm ngặt danh sách từ cấm (Don't words).
`;
}

function getProductInstructions(rules, products) {
  const safeRules = Array.isArray(rules) ? rules : [];

  const productRules = safeRules
    .filter((r) => r.type === 'product')
    .map((r) => `- [SOP ${r.label}]: ${r.content}`)
    .join('\n');

  const productList = Array.isArray(products)
    ? products
    : products
    ? [products]
    : [];

  let productContext = "Không có sản phẩm cụ thể.";
  if (productList.length > 0) {
    productContext = productList
      .map(
        (p, index) => `
[SẢN PHẨM ${index + 1}: ${p.name || 'Chưa đặt tên'}]
- Khách hàng mục tiêu: ${p.target_audience || 'Chưa xác định'}
- Lợi ích cốt lõi: ${p.benefits || 'Chưa xác định'}
- USP (Điểm khác biệt): ${p.usp || 'Chưa xác định'}
`
      )
      .join('\n');
  }

  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LAYER 4: PRODUCT PROFILE (SẢN PHẨM)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHẠM VI (SCOPE): Category "product".

${productContext}
- SOP Sản phẩm:
${productRules || '- Không được nói sai công dụng hoặc bỏ qua USP quan trọng của sản phẩm.'}

NHIỆM VỤ:
- Kiểm tra xem bài viết có đang mô tả sai tính năng, sai USP hoặc nhắm sai đối tượng khách hàng (Persona) không.
`;
}

// Robust JSON parsing helper
function safeJSONParse(text) {
  try {
    // 1. Clean Markdown code blocks if any
    let cleaned = text.trim();
    const markdownMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (markdownMatch) {
      cleaned = markdownMatch[1];
    }

    // 2. Find outermost JSON brackets
    const firstOpen = cleaned.indexOf('{');
    const lastClose = cleaned.lastIndexOf('}');
    
    if (firstOpen !== -1 && lastClose !== -1) {
      cleaned = cleaned.substring(firstOpen, lastClose + 1);
      return JSON.parse(cleaned);
    }
    
    // 3. Fallback: try parsing directly just in case
    return JSON.parse(text);
  } catch (error) {
    console.warn("JSON parse failed, attempting naive cleanup...", error);
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
Bạn là Hệ thống MOODBIZ AI Auditor v9.7 - Chuyên gia Đánh giá Nội dung chuẩn Enterprise.

${getLanguageInstructions(safeRules, language, platform, platformRules)}
${getLogicInstructions(safeRules)}
${getBrandInstructions(brand, safeRules)}
${getProductInstructions(safeRules, targetProducts)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VĂN BẢN CẦN KIỂM DUYỆT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"${text}"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
YÊU CẦU XỬ LÝ (QUAN TRỌNG)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. KHÔNG GIỚI HẠN SỐ LƯỢNG LỖI (NO LIMIT):
   - Bạn phải báo cáo TOÀN BỘ lỗi tìm thấy, dù là nhỏ nhất.
   - Không được bỏ qua lỗi vì sợ danh sách quá dài.
   - Đặc biệt chú ý bắt hết các lỗi dính chữ và khoảng trắng (Formatting) đã nêu ở Layer 1.

2. PHÂN LOẠI CHÍNH XÁC (STRICT CATEGORIZATION):
   - Nếu là lỗi chính tả/dấu câu/ngữ pháp/định dạng -> Bắt buộc gán category: "language".
   - Nếu là lỗi logic/sự thật/mâu thuẫn -> Gán category: "ai_logic".
   - Nếu sai giọng văn/từ cấm -> Gán category: "brand".
   - Nếu sai thông tin sản phẩm -> Gán category: "product".

3. CẤU TRÚC JSON BẮT BUỘC:
   - TRẢ VỀ JSON HỢP LỆ (RFC 8259).
   - KHÔNG dùng Markdown block (như \`\`\`json).
   - ESCAPE cẩn thận các ký tự đặc biệt trong chuỗi (ví dụ: dấu ngoặc kép " phải thành \\").
   
JSON Template:
{
  "summary": "Tóm tắt 2-3 câu về chất lượng bài viết.",
  "identified_issues": [
    {
      "category": "language | ai_logic | brand | product",
      "problematic_text": "Trích dẫn chính xác đoạn văn bị lỗi (Escape quote nếu có)",
      "citation": "Tên quy tắc vi phạm (VD: SOP RULE: Viết hoa, Standard Formatting...)",
      "reason": "Giải thích theo cấu trúc 'The Because Framework' (WHAT + WHY + IMPACT).",
      "severity": "High | Medium | Low",
      "suggestion": "Gợi ý viết lại đoạn đó cho đúng chuẩn."
    }
  ]
}

NẾU KHÔNG PHÁT HIỆN LỖI:
- Trả về mảng "identified_issues" rỗng ([]).
`;

    const apiKey = process.env.GEMINI_API_KEY;
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`;

    const requestBody = {
      contents: [{ parts: [{ text: corePrompt }] }],
      generationConfig: {
        temperature: 0.2, 
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
    } catch (parseErr) {
      console.error("Gemini Audit JSON Parse Error:", parseErr);
      console.error("Raw Text Result:", textResult);
      jsonResult = {
        summary: "Hệ thống AI trả về dữ liệu không đúng định dạng JSON. (Raw: " + textResult.substring(0, 100) + "...)",
        identified_issues: [],
      };
    }

    return res.status(200).json({ result: jsonResult, success: true });
  } catch (e) {
    console.error("Audit API Error:", e);
    return res.status(500).json({ error: 'Server error', message: e.message });
  }
};
