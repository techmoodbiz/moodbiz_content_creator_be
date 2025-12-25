
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
NGUỒN DỮ LIỆU: SOP SYSTEM (Database Rules).

QUY ĐỊNH BẮT BUỘC:
1. MỌI lỗi về chính tả, dấu câu, khoảng trắng, viết hoa, format ĐỀU PHẢI thuộc category "language".
2. KIỂM TRA LỖI DÍNH CHỮ & KHOẢNG TRẮNG:
  - [LỖI DÍNH CHỮ]: Thiếu khoảng trắng SAU dấu câu (, . ; : …).
  - [LỖI THỪA KHOẢNG TRẮNG]: Có khoảng trắng TRƯỚC dấu câu.

CÁC QUY CHUẨN SOP CỤ THỂ (ƯU TIÊN CAO NHẤT):
Dưới đây là các quy tắc cụ thể từ hệ thống SOP. Nếu vi phạm, hãy trích dẫn tên Rule (thuộc tính 'name').
${langRules || '(Không có quy chuẩn ngôn ngữ bổ sung được cung cấp.)'}

PLATFORM COMPLIANCE (CHUẨN KÊNH ${String(platform || '').toUpperCase()}):
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
NGUỒN DỮ LIỆU: SOP SYSTEM (Database Rules).
NEGATIVE CONSTRAINT: KHÔNG báo lỗi chính tả ở đây.

QUY CHUẨN SOP LOGIC:
${logicRulesFromSOP || '<Rule name="Internal Consistency">Đánh dấu lỗi khi hai đoạn trong cùng bài tự mâu thuẫn nhau.</Rule>'}

NHIỆM VỤ:
- Phát hiện Hallucinations (Ảo giác AI): Thông tin bịa đặt không có thật.
- Phát hiện Mâu thuẫn nội tại: Đoạn trước đá đoạn sau.
- Phát hiện Lỗi Lập luận: Suy diễn không logic.
`;
}

function getBrandInstructions(brand = {}) {
  // Brand Block chỉ lấy dữ liệu từ Brand Object, KHÔNG lấy từ rules array nữa
  
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
NGUỒN DỮ LIỆU: BRAND PROFILE (Từ Collection Brands).

Dữ liệu Brand (Đây là "Single Source of Truth"):
- Voice/Tone (Giọng văn): ${brand.voice || brand.tone_of_voice || 'Chưa xác định'}
- Personality (Tính cách): ${personality}
- Do Words (Từ khóa NÊN dùng): ${(Array.isArray(brand.do_words) && brand.do_words.join(', ')) || 'Không có'}
- Don't Words (Từ khóa CẤM dùng): ${(Array.isArray(brand.dont_words) && brand.dont_words.join(', ')) || 'Không có'}

NHIỆM VỤ:
- Đối chiếu văn bản với Voice/Tone và Personality ở trên. Nếu lệch pha (ví dụ: Brand nghiêm túc mà viết quá teen), hãy báo lỗi.
- Quét tìm các từ trong danh sách "Don't Words". Nếu xuất hiện, báo lỗi nghiêm trọng (High Severity).
- KHÔNG sử dụng các quy tắc chung chung bên ngoài. Chỉ bám sát dữ liệu trên.
`;
}

function getProductInstructions(products) {
  // Product Block chỉ lấy dữ liệu từ Products Array, KHÔNG lấy từ rules array nữa

  const productList = Array.isArray(products)
    ? products
    : products
    ? [products]
    : [];

  let productContext = "Không có sản phẩm cụ thể được chọn. Bỏ qua kiểm tra tính năng chi tiết, chỉ kiểm tra lỗi logic sản phẩm chung.";
  
  if (productList.length > 0) {
    productContext = productList
      .map((p, index) => `
[SẢN PHẨM ${index + 1}: ${p.name || 'Chưa đặt tên'}]
- Khách hàng mục tiêu: ${p.target_audience || 'N/A'}
- Lợi ích (Benefits): ${p.benefits || 'N/A'}
- USP (Lợi thế bán hàng): ${p.usp || 'N/A'}
`)
      .join('\n');
  }

  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LAYER 4: PRODUCT PROFILE (SẢN PHẨM)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHẠM VI (SCOPE): Category "product".
NGUỒN DỮ LIỆU: PRODUCT COLLECTION.

THÔNG TIN SẢN PHẨM ĐƯỢC CUNG CẤP:
${productContext}

NHIỆM VỤ:
- Hallucination Check: Kiểm tra xem văn bản có bịa đặt tính năng nào KHÔNG có trong thông tin trên không.
- Omission Check: Kiểm tra xem văn bản có bỏ sót USP quan trọng nhất (Lợi thế cạnh tranh) không.
- Wrong Audience: Kiểm tra xem giọng văn có phù hợp với "Khách hàng mục tiêu" đã định nghĩa không.
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
Bạn là Hệ thống MOODBIZ AI Auditor v9.9.

${getLanguageInstructions(safeRules, language, platform, platformRules)}
${getLogicInstructions(safeRules)}
${getBrandInstructions(brand)}
${getProductInstructions(targetProducts)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VĂN BẢN CẦN KIỂM DUYỆT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"${text}"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HƯỚNG DẪN TRÍCH DẪN (CITATION) & PHÂN LOẠI
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Hệ thống đã cung cấp các quy tắc SOP dưới dạng thẻ XML <Rule name="...">...</Rule>.

ĐỊNH NGHĨA CATEGORY CHO OUTPUT JSON:
1. "language": Lỗi chính tả, dấu câu, format, viết hoa, ngữ pháp (Dựa trên Layer 1).
2. "ai_logic": Lỗi logic, mâu thuẫn, thông tin bịa đặt, lập luận yếu (Dựa trên Layer 2).
3. "brand": Sai giọng văn, sai tính cách, dùng từ cấm (Dựa trên Layer 3 - Brand Profile).
4. "product": Sai thông tin sản phẩm, thiếu USP, sai đối tượng mục tiêu (Dựa trên Layer 4 - Product Profile).

HƯỚNG DẪN XỬ LÝ CITATION:
1. NẾU VI PHẠM SOP (Layer 1 & 2):
   - Tìm thẻ <Rule> tương ứng.
   - Lấy giá trị của thuộc tính "name" và điền vào trường "citation".
2. NẾU VI PHẠM BRAND/PRODUCT (Layer 3 & 4):
   - Điền "Brand Identity Violation" (nếu sai Brand).
   - Điền "Product Fact Violation" (nếu sai thông tin Product).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
QUY TẮC "NEGATIVE CONSTRAINT" (TUYỆT ĐỐI TUÂN THỦ)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. CHỈ báo cáo các lỗi VI PHẠM thực sự (Violations).
2. NẾU văn bản ĐÃ ĐÚNG hoặc PHÙ HỢP: TUYỆT ĐỐI KHÔNG đưa vào danh sách output.
3. KHÔNG BAO GIỜ tạo ra suggestion kiểu "Giữ nguyên", "Keep as is", "Đã tốt", "Đã đúng", "Không cần sửa". Nếu tốt rồi, hãy bỏ qua.
4. KHÔNG báo cáo trùng lặp (Duplicate): Nếu 1 đoạn văn bản vi phạm nhiều lỗi, hãy gộp chúng lại hoặc chỉ báo lỗi nghiêm trọng nhất.
5. Kiểm tra kỹ "problematic_text": Nó phải trích dẫn chính xác từ văn bản gốc.

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
      "citation": "TÊN RULE VI PHẠM HOẶC LOẠI VI PHẠM",
      "reason": "Giải thích ngắn gọn tại sao lỗi.",
      "severity": "High | Medium | Low",
      "suggestion": "Đề xuất sửa (KHÔNG ĐƯỢC LÀ 'Giữ nguyên')"
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
      
      // Post-process: Lọc bỏ các issue "ảo" ngay tại backend nếu AI vẫn cứng đầu trả về
      if (jsonResult.identified_issues && Array.isArray(jsonResult.identified_issues)) {
        jsonResult.identified_issues = jsonResult.identified_issues.filter(issue => {
           const suggestion = (issue.suggestion || '').toLowerCase();
           const reason = (issue.reason || '').toLowerCase();
           const prob = (issue.problematic_text || '').toLowerCase();
           
           // Filter 1: Bỏ nếu suggestion là "giữ nguyên"
           if (suggestion.includes('giữ nguyên') || suggestion.includes('keep as is') || suggestion.includes('không cần sửa')) return false;
           
           // Filter 2: Bỏ nếu reason là lời khen
           if (reason.includes('phù hợp') || reason.includes('đã đúng')) return false;
           
           // Filter 3: Bỏ nếu suggestion giống hệt problematic_text
           if (issue.suggestion?.trim() === issue.problematic_text?.trim()) return false;
           
           return true;
        });
      }

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
