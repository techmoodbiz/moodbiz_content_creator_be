
// api/audit.js
const fetch = require('node-fetch');

// --- HELPER: PROMPT TEMPLATES ---

function getLanguageInstructions(rules, language, platform, platformRules) {
  // Normalize input language code
  const targetLang =
    language === 'Vietnamese'
      ? 'vi'
      : language === 'English'
      ? 'en'
      : language === 'Japanese'
      ? 'ja'
      : language;

  // Safety check ensure rules is array
  const safeRules = Array.isArray(rules) ? rules : [];

  const langRules = safeRules
    .filter((r) => {
      // Type must be language AND (apply_to_language is missing OR 'all' OR matches target)
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
LAYER 1: LANGUAGE & PLATFORM FORMAT (NGÔN NGỮ & ĐỊNH DẠNG KÊNH)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NHIỆM VỤ: Bạn là "Grammar Nazi" (Cảnh sát chính tả) cực kỳ khó tính.

1. KIỂM TRA LỖI DÍNH CHỮ & KHOẢNG TRẮNG (ƯU TIÊN SỐ 1 - BẮT BUỘC BẮT):
  Bạn phải soi từng ký tự dấu câu. Nếu thấy lỗi sau, hãy FLAG ngay lập tức vào danh sách lỗi (High/Medium Severity):
  - [LỖI DÍNH CHỮ]: Thiếu khoảng trắng SAU dấu câu (, . ; : …).
    + Ví dụ SAI: "link,…Các", "abc,def", "hết câu.Bắt đầu".
    + Ví dụ ĐÚNG: "link,… Các", "abc, def", "hết câu. Bắt đầu".
  - [LỖI THỪA KHOẢNG TRẮNG]: Có khoảng trắng TRƯỚC dấu câu.
    + Ví dụ SAI: "kết thúc .", "liên kết ,".
    + Ví dụ ĐÚNG: "kết thúc.", "liên kết,".
  - [LỖI NHẤT QUÁN]: Viết hoa tùy tiện (Ví dụ: lúc thì "Backlink", lúc thì "backlink").

2. PLATFORM COMPLIANCE (CHUẨN KÊNH ${String(platform || '').toUpperCase()}):
  - Quy tắc kênh: ${
    platformRules ||
    'Tuân thủ định dạng chuẩn, độ dài và văn phong phù hợp với hành vi đọc trên kênh này.'
  }

Ngôn ngữ mục tiêu: ${language || 'Không xác định'}

Quy chuẩn SOP bổ sung (Language Rules):
${langRules || '- (Không có quy chuẩn ngôn ngữ bổ sung được cung cấp.)'}
`;
}

function getLogicInstructions(rules) {
  const safeRules = Array.isArray(rules) ? rules : [];
  
  const logicRulesFromSOP = safeRules
    .filter((r) => r.type === 'ai_logic')
    .map((r) => `- [SOP RULE: ${r.label}]: ${r.content}`)
    .join('\n');

  const defaultLogicRules = `
- [SOP RULE: AI-HALLUCINATION]: Không được kết luận \"sai sự thật\" nếu không có bằng chứng ngay trong văn bản hoặc tài liệu được cung cấp. Nếu nghi ngờ nhưng không chắc chắn, hãy ghi nhận trong "summary" thay vì tạo "identified_issues".
- [SOP RULE: INTERNAL-CONSISTENCY]: Đánh dấu lỗi khi hai đoạn trong cùng bài tự mâu thuẫn nhau về số liệu, tên, thời gian hoặc kết luận.
- [SOP RULE: CONTEXT-RELEVANCE]: Đánh dấu lỗi khi thông tin đúng nhưng không liên quan mục tiêu, brief hoặc không phục vụ người đọc.
`;

  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LAYER 2: AI LOGIC & ACCURACY (LOGIC & SỰ THẬT)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Quy chuẩn SOP (Logic Rules):
${logicRulesFromSOP || defaultLogicRules}

PHẠM VI ĐÁNH GIÁ:
- Bạn CHỈ được đánh giá logic nội tại, tính nhất quán và mức độ phù hợp ngữ cảnh DỰA TRÊN:
  (1) Chính văn bản được cung cấp,
  (2) Các SOP phía trên.
- Bạn KHÔNG được tự ý fact-check các dữ kiện bên ngoài (thị trường, lịch sử, số liệu chung) nếu trong văn bản không đề cập. Trong trường hợp nghi ngờ nhưng không đủ chứng cứ, hãy ghi rõ là "Không chắc chắn" trong phần "summary" và KHÔNG thêm vào "identified_issues".

NHIỆM VỤ:
- Đọc kỹ để tìm mâu thuẫn: Ví dụ, đầu bài nói A nhưng cuối bài lại phủ định A hoặc đưa số liệu khác.
- Phát hiện ảo giác AI (Hallucinations): Các thông tin nghe có vẻ hay nhưng không có căn cứ rõ ràng trong chính văn bản (ví dụ: tự nhiên xuất hiện số liệu cụ thể mà không được giải thích).
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

  const coreValues =
    (Array.isArray(brand.core_values) && brand.core_values.join(', ')) ||
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
Dữ liệu gốc từ Brand Profile của ${brand.name || 'Thương hiệu'}:
1. [VOICE/TONE]: ${brand.voice || brand.tone_of_voice || 'Chưa xác định'}
2. [PERSONALITY]: ${personality}
3. [CORE VALUES]: ${coreValues}
4. [DO WORDS]: ${doWords}
5. [DON'T WORDS]: ${dontWords}

Quy chuẩn SOP bổ sung:
${brandRules || '- Tuyệt đối trung thành với bản sắc thương hiệu, tránh văn phong chung chung giống văn mẫu AI.'}

NHIỆM VỤ:
- Cảm nhận "Hồn" thương hiệu: Bài viết này có giống do người của ${
    brand.name || 'thương hiệu'
  } viết không, hay giống văn mẫu AI vô hồn?
- Kiểm tra từ cấm/từ nên dùng có bị vi phạm hoặc bỏ sót không.
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

  if (productList.length === 0) {
    return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LAYER 4: PRODUCT PROFILE (PASSIVE MODE)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Không có sản phẩm cụ thể được cung cấp.
Chỉ kiểm tra các lỗi logic sản phẩm chung chung nếu có vi phạm nghiêm trọng quy tắc chung bên dưới:

${productRules || '(Không có quy chuẩn sản phẩm cụ thể).'}

NHIỆM VỤ:
- Chỉ flag lỗi product nếu bài viết mô tả tính năng/công dụng quá phi thực tế hoặc dễ gây hiểu lầm nghiêm trọng cho người đọc.
`;
  }

  const productContext = productList
    .map(
      (p, index) => `
[SẢN PHẨM ${index + 1}: ${p.name || 'Chưa đặt tên'}]
- Khách hàng mục tiêu: ${p.target_audience || 'Chưa xác định'}
- Lợi ích cốt lõi: ${p.benefits || 'Chưa xác định'}
- USP (Điểm khác biệt): ${p.usp || 'Chưa xác định'}
`
    )
    .join('\n');

  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LAYER 4: PRODUCT PROFILE (SẢN PHẨM)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${productContext}
- SOP Sản phẩm:
${productRules || '- Không được nói sai công dụng hoặc bỏ qua USP quan trọng của sản phẩm.'}

NHIỆM VỤ:
- Kiểm tra xem bài viết có đang mô tả sai tính năng, sai USP hoặc nhắm sai đối tượng khách hàng (Persona) không.
- Ưu tiên flag lỗi nếu có nguy cơ gây hiểu lầm lớn về lợi ích hoặc rủi ro của sản phẩm.
`;
}

module.exports = async function handler(req, res) {
  // CORS HEADERS MUST BE SET FIRST
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

  // Handle preflight immediately
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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

    // Safety: ensure rules is strictly an array to prevent filter errors later
    const safeRules = Array.isArray(rules) ? rules : [];
    const targetProducts = products || product;

    const corePrompt = `
Bạn là Hệ thống MOODBIZ AI Auditor v8.5 - Chuyên gia Đánh giá Nội dung chuẩn Enterprise.

${getLanguageInstructions(safeRules, language, platform, platformRules)}
${getLogicInstructions(safeRules)}
${getBrandInstructions(brand, safeRules)}
${getProductInstructions(safeRules, targetProducts)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VĂN BẢN CẦN KIỂM DUYỆT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"${text}"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CHAIN OF THOUGHT (QUY TRÌNH SUY LUẬN BẮT BUỘC - ẨN, KHÔNG IN RA)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Trước khi đưa ra kết luận, bạn hãy suy luận NGẦM (KHÔNG in ra) theo các bước:
1. Phân tích ngữ cảnh: Bài viết này đăng ở đâu (${platform})? Ai đọc? Mục đích là gì?
2. Đối chiếu 4 lớp: So sánh văn bản với 4 Layer quy chuẩn phía trên. Chú ý đặc biệt đến các lỗi khoảng trắng và dấu câu đã được hướng dẫn ở Layer 1.
3. Đánh giá tác động: Lỗi này ảnh hưởng thế nào đến cảm xúc người đọc (gây khó chịu, hiểu lầm, hay mất uy tín)?

Chỉ sau khi đã suy luận xong, bạn mới sinh ra OUTPUT JSON theo đúng cấu trúc bên dưới.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HƯỚNG DẪN VIẾT "REASON" - CẤU TRÚC "THE BECAUSE FRAMEWORK"
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Bạn KHÔNG ĐƯỢC viết lý do chung chung như "Sai Brand Voice" hay "Lỗi chính tả".
Bạn PHẢI viết trường "reason" theo cấu trúc 3 phần sau:

1. WHAT (Lỗi gì?): Chỉ rõ từ/cụm từ sai.
2. WHY (Tại sao sai?): Vi phạm quy tắc nào hoặc không phù hợp ngữ cảnh nào.
3. IMPACT (Hệ quả): Gây ảnh hưởng gì tới người đọc/thương hiệu.

Ví dụ TỆ:
"Dùng từ sai."

Ví dụ TỐT:
"Dùng từ 'quý khách' (WHAT - Lỗi) quá trang trọng so với không khí Facebook (WHY - Vi phạm Context), tạo cảm giác xa cách và hành chính (IMPACT - Hệ quả)."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ĐỊNH NGHĨA MỨC ĐỘ NGHIÊM TRỌNG (SEVERITY)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- High: Sai lệch sự thật sản phẩm, vi phạm từ cấm (Don't words), ngôn ngữ xúc phạm, hoặc lỗi formatting (khoảng trắng/dấu câu) gây khó chịu nghiêm trọng.
- Medium: Sai Brand Voice, lỗi logic, cấu trúc lủng củng, CTA yếu.
- Low: Lỗi chính tả nhỏ ít ảnh hưởng.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT JSON FORMAT - QUY ĐỊNH NGHIÊM NGẶT & ANTI-NITPICKING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
YÊU CẦU:
1. Bạn PHẢI trả về DUY NHẤT MỘT object JSON HỢP LỆ.
2. KHÔNG được in ra bất kỳ text, giải thích, markdown, hoặc ký tự nào ở ngoài JSON.
3. KHÔNG dùng \`\`\`, KHÔNG dùng \`\`\`json, KHÔNG comment trong JSON.

CHỐNG NITPICKING (Bới lông tìm vết):
- Chỉ báo cáo tối đa 3-5 lỗi quan trọng nhất (High/Medium) cho mỗi Category.
- Bỏ qua các lỗi "Low" lặt vặt trừ khi chúng xuất hiện quá dày đặc làm giảm chất lượng bài viết.
- **NGOẠI LỆ:** Đối với lỗi Formatting (dính chữ, thừa khoảng trắng), hãy báo cáo hết vì đây là lỗi kỹ thuật không thể chấp nhận.

CẤU TRÚC JSON BẮT BUỘC:
{
  "summary": "Tóm tắt 2-3 câu về chất lượng bài viết dưới góc độ chuyên gia.",
  "identified_issues": [
    {
      "category": "language | ai_logic | brand | product",
      "problematic_text": "Trích dẫn chính xác đoạn văn bị lỗi",
      "citation": "Tên quy tắc vi phạm. Ưu tiên dùng chính xác 'label' của SOP Rule nếu có (VD: 'SOP RULE: Viết hoa', 'SOP RULE: AI-HALLUCINATION'). Nếu không, dùng tên chung.",
      "reason": "Giải thích theo cấu trúc 'The Because Framework' (WHAT + WHY + IMPACT).",
      "severity": "High | Medium | Low",
      "suggestion": "Gợi ý viết lại đoạn đó cho đúng chuẩn."
    }
  ]
}

NẾU KHÔNG PHÁT HIỆN LỖI NGHIÊM TRỌNG:
- Vẫn phải trả về JSON với mảng "identified_issues" rỗng ([]).
- "summary" vẫn phải có nhận xét tổng quan tích cực.
`;

    // Optional: few-shot example to stabilize JSON shape
    const fewShotExample = `
VÍ DỤ JSON ĐÚNG (CHỈ LÀ VÍ DỤ, KHÔNG ÁP DỤNG NGUYÊN VẸN CHO BÀI HIỆN TẠI):

{
  "summary": "Bài viết nhìn chung đúng brand voice, ít lỗi chính tả, nhưng có 1 chỗ mô tả sai USP của sản phẩm.",
  "identified_issues": [
    {
      "category": "language",
      "problematic_text": "sản phẩm .",
      "citation": "Lỗi Formatting",
      "reason": "WHAT: Thừa khoảng trắng trước dấu chấm. WHY: Vi phạm quy tắc trình bày văn bản chuẩn. IMPACT: Gây cảm giác thiếu chuyên nghiệp và cẩu thả.",
      "severity": "Medium",
      "suggestion": "sản phẩm."
    },
    {
      "category": "product",
      "problematic_text": "\\"Giúp doanh nghiệp tăng doanh thu gấp 10 lần chỉ sau 1 tuần\\"",
      "citation": "SOP RULE: Product Claims",
      "reason": "WHAT: Câu hứa hẹn 'tăng doanh thu gấp 10 lần chỉ sau 1 tuần' là phi thực tế. WHY: Vi phạm quy chuẩn về cam kết sản phẩm, không có căn cứ trong mô tả sản phẩm gốc. IMPACT: Dễ gây hiểu lầm nghiêm trọng, làm giảm uy tín thương hiệu nếu khách hàng không đạt được kết quả như vậy.",
      "severity": "High",
      "suggestion": "Chuyển thành cam kết thực tế hơn, ví dụ: 'Giúp doanh nghiệp cải thiện hiệu quả bán hàng trong 4-6 tuần nếu triển khai đầy đủ quy trình.'"
    }
  ]
}

GIỜ HÃY TẠO JSON CHO BÀI VIẾT ĐƯỢC CUNG CẤP, TUÂN THỦ CHẶT CHẼ CẤU TRÚC TRÊN.
`;

    const prompt = corePrompt + '\n' + fewShotExample;

    const apiKey = process.env.GEMINI_API_KEY;
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`;

    const requestBody = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2, // Low temperature for consistent critique
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
    const textResult =
      data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    let jsonResult;
    try {
      // Basic sanitization: in case model still wraps with ```
      const cleaned = textResult
        .trim()
        .replace(/^\s*```json\s*/i, '')
        .replace(/^\s*```/i, '')
        .replace(/\s*```\s*$/i, '');
      jsonResult = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error("Gemini Audit JSON Parse Error:", parseErr);
      console.error("Raw Text Result:", textResult);
      
      // Fallback: treat entire text as summary
      jsonResult = {
        summary: textResult || 'Không parse được JSON từ mô hình (Xem server logs).',
        identified_issues: [],
      };
    }

    return res.status(200).json({ result: jsonResult, success: true });
  } catch (e) {
    console.error("Audit API Error:", e);
    // Return error as JSON to avoid blocking frontend with 500 HTML page (which causes CORS errors too sometimes)
    return res.status(500).json({ error: 'Server error', message: e.message });
  }
};
