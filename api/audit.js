
const fetch = require('node-fetch');

// --- HELPER: PROMPT TEMPLATES ---

function getLanguageInstructions(rules, language, platform, platformRules) {
  const targetLang =
    language === 'Vietnamese' ? 'vi' : language === 'English' ? 'en' : language === 'Japanese' ? 'ja' : language;

  const safeRules = Array.isArray(rules) ? rules : [];

  // Sử dụng cấu trúc XML <Rule> để AI dễ dàng trích dẫn
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
PHẠM VI (SCOPE): Category "language".
NHIỆM VỤ: Bạn là "Grammar Nazi". Hãy bắt lỗi chính tả, ngữ pháp, và định dạng văn bản.

1. KIỂM TRA LỖI DÍNH CHỮ & KHOẢNG TRẮNG (BẮT BUỘC):
  - [LỖI DÍNH CHỮ]: Thiếu khoảng trắng SAU dấu câu (, . ; : …).
  - [LỖI THỪA KHOẢNG TRẮNG]: Có khoảng trắng TRƯỚC dấu câu.

2. CÁC QUY CHUẨN SOP CỤ THỂ (ƯU TIÊN CAO NHẤT):
Dưới đây là các quy tắc cụ thể từ hệ thống SOP. Nếu vi phạm, hãy trích dẫn tên Rule (thuộc tính 'name').
${langRules || '(Không có quy chuẩn ngôn ngữ bổ sung được cung cấp.)'}

3. PLATFORM COMPLIANCE (CHUẨN KÊNH ${String(platform || '').toUpperCase()}):
  - ${platformRules || 'Tuân thủ định dạng chuẩn, độ dài và văn phong phù hợp với hành vi đọc trên kênh này.'}
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
LAYER 2: AI LOGIC & ACCURACY (LOGIC & SỰ THẬT)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHẠM VI (SCOPE): Category "ai_logic".
NEGATIVE CONSTRAINT: KHÔNG báo lỗi chính tả ở đây.

QUY CHUẨN SOP LOGIC:
${logicRulesFromSOP || '<Rule name="Internal Consistency">Đánh dấu lỗi khi hai đoạn trong cùng bài tự mâu thuẫn nhau.</Rule>'}

NHIỆM VỤ:
- Phát hiện Hallucinations (Ảo giác AI).
- Phát hiện Mâu thuẫn nội tại.
- Phát hiện Lỗi Lập luận.
`;
}

function getBrandInstructions(brand = {}, rules) {
  const safeRules = Array.isArray(rules) ? rules : [];

  const brandRules = safeRules
    .filter((r) => r.type === 'brand')
    .map((r) => `<Rule name="${r.label}">\n${r.content}\n</Rule>`)
    .join('\n');

  const personality =
    (Array.isArray(brand.brand_personality) &&
      brand.brand_personality.join(', ')) ||
    brand.personality ||
    'Chưa xác định';

  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LAYER 3: BRAND IDENTITY (THƯƠNG HIỆU)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHẠM VI (SCOPE): Category "brand".

Dữ liệu Brand:
- Voice/Tone: ${brand.voice || brand.tone_of_voice || 'Chưa xác định'}
- Personality: ${personality}
- Do Words: ${(Array.isArray(brand.do_words) && brand.do_words.join(', ')) || 'Không có'}
- Don't Words: ${(Array.isArray(brand.dont_words) && brand.dont_words.join(', ')) || 'Không có'}

QUY CHUẨN SOP BRAND BỔ SUNG:
${brandRules || '<Rule name="Brand Consistency">Tuyệt đối trung thành với bản sắc thương hiệu.</Rule>'}
`;
}

function getProductInstructions(rules, products) {
  const safeRules = Array.isArray(rules) ? rules : [];

  const productRules = safeRules
    .filter((r) => r.type === 'product')
    .map((r) => `<Rule name="${r.label}">\n${r.content}\n</Rule>`)
    .join('\n');

  const productList = Array.isArray(products)
    ? products
    : products
    ? [products]
    : [];

  let productContext = "Không có sản phẩm cụ thể.";
  if (productList.length > 0) {
    productContext = productList
      .map((p, index) => `[SẢN PHẨM ${index + 1}: ${p.name || 'Chưa đặt tên'}] USP: ${p.usp || ''}`)
      .join('\n');
  }

  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LAYER 4: PRODUCT PROFILE (SẢN PHẨM)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHẠM VI (SCOPE): Category "product".
${productContext}

QUY CHUẨN SOP SẢN PHẨM:
${productRules || '<Rule name="Product Accuracy">Không được nói sai công dụng hoặc bỏ qua USP quan trọng.</Rule>'}
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
    console.warn("JSON parse failed", error);
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
Bạn là Hệ thống MOODBIZ AI Auditor v9.9.

${getLanguageInstructions(safeRules, language, platform, platformRules)}
${getLogicInstructions(safeRules)}
${getBrandInstructions(brand, safeRules)}
${getProductInstructions(safeRules, targetProducts)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VĂN BẢN CẦN KIỂM DUYỆT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"${text}"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HƯỚNG DẪN TRÍCH DẪN (CITATION) - QUAN TRỌNG
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Hệ thống đã cung cấp các quy tắc SOP dưới dạng thẻ XML <Rule name="...">...</Rule>.
Khi phát hiện một lỗi, bạn phải xác định nó vi phạm thẻ Rule nào.

1. NẾU VI PHẠM SOP CỤ THỂ:
   - Tìm thẻ <Rule> tương ứng.
   - Lấy giá trị của thuộc tính "name" và điền vào trường "citation".
   - VÍ DỤ: Nếu vi phạm <Rule name="Quy chuẩn tiếng Việt 01">, thì "citation": "Quy chuẩn tiếng Việt 01".

2. NẾU VI PHẠM KIẾN THỨC PHỔ THÔNG (KHÔNG CÓ TRONG SOP):
   - Điền "Standard Grammar" (nếu là lỗi ngữ pháp cơ bản).
   - Điền "Universal Logic" (nếu là lỗi logic thông thường).
   - Điền "Brand Identity" (nếu sai lệch giọng văn chung).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT JSON FORMAT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Trả về JSON hợp lệ (RFC 8259), không dùng Markdown block.
{
  "summary": "Tóm tắt đánh giá.",
  "identified_issues": [
    {
      "category": "language | ai_logic | brand | product",
      "problematic_text": "Trích dẫn đoạn lỗi",
      "citation": "TÊN RULE VI PHẠM (Lấy từ thuộc tính 'name' của thẻ <Rule>)",
      "reason": "Giải thích ngắn gọn tại sao lỗi.",
      "severity": "High | Medium | Low",
      "suggestion": "Đề xuất sửa."
    }
  ]
}
`;

    const apiKey = process.env.GEMINI_API_KEY;
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`;

    const requestBody = {
      contents: [{ parts: [{ text: corePrompt }] }],
      generationConfig: {
        temperature: 0.1, // Cực thấp để đảm bảo tuân thủ Citation chính xác
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
      console.error("JSON Parse Error:", parseErr);
      jsonResult = {
        summary: "Lỗi định dạng phản hồi từ AI. Vui lòng thử lại.",
        identified_issues: [],
      };
    }

    return res.status(200).json({ result: jsonResult, success: true });
  } catch (e) {
    console.error("Audit API Error:", e);
    return res.status(500).json({ error: 'Server error', message: e.message });
  }
};
