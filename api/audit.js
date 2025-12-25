
// api/audit.js
const fetch = require('node-fetch');

// --- HELPER: PROMPT TEMPLATES ---

function getLanguageInstructions(rules, language, platform, platformRules) {
  // Normalize input language code
  const targetLang = language === 'Vietnamese' ? 'vi' : language === 'English' ? 'en' : language === 'Japanese' ? 'ja' : language;
  
  const langRules = rules
    .filter(r => {
      // Filter logic: Type must be language AND (apply_to_language is missing OR 'all' OR matches target)
      return r.type === 'language' && 
             (!r.apply_to_language || r.apply_to_language === 'all' || r.apply_to_language === targetLang);
    })
    .map(r => `- [SOP RULE: ${r.label}]: ${r.content}`)
    .join('\n');

  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LAYER 1: LANGUAGE & ORTHOGRAPHY (CHÍNH TẢ & NGỮ PHÁP) - ƯU TIÊN CAO NHẤT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NHIỆM VỤ QUAN TRỌNG NHẤT: Bạn là một biên tập viên soát lỗi (Proofreader) cực kỳ khó tính. Bạn KHÔNG được bỏ qua các lỗi nhỏ.
Hãy soi từng từ một để tìm ra các lỗi sau:

1. LỖI CHÍNH TẢ & TYPO (BẮT BUỘC BẮT):
   - Sai dấu (hỏi/ngã, huyền/sắc).
   - Sai phụ âm đầu/cuối (d/gi, ch/tr, s/x, n/ng).
   - Lỗi đánh máy (Typos): thừa/thiếu ký tự (vd: "maketing", "bussiness", "kháchhang").
   - Từ vô nghĩa hoặc dùng từ sai ngữ cảnh nghiêm trọng.

2. LỖI TRÌNH BÀY (TYPOGRAPHY):
   - Thừa khoảng trắng (double spaces).
   - Khoảng trắng trước dấu câu (vd: "xin chào , bạn" -> Sai).
   - Thiếu khoảng trắng sau dấu câu (vd: "chào.bạn" -> Sai).
   - Viết hoa tùy tiện không đúng danh từ riêng.

Tiêu chuẩn Kênh (${platform}): ${platformRules || "Đảm bảo đúng định dạng platform."}
Ngôn ngữ mục tiêu: ${language}

Quy chuẩn SOP bổ sung (Language Rules):
${langRules || ""}
`;
}

function getLogicInstructions(rules) {
  const logicRules = rules
    .filter(r => r.type === 'ai_logic')
    .map(r => `- [SOP RULE: ${r.label}]: ${r.content}`)
    .join('\n');

  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LAYER 2: AI LOGIC & ACCURACY (LOGIC & SỰ THẬT)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Quy chuẩn SOP (Logic Rules):
${logicRules || "- [SOP RULE: Consistency]: Thông tin phải nhất quán.\n- [SOP RULE: Fact Check]: Không có sự mâu thuẫn về số liệu hoặc mốc thời gian."}

NHIỆM VỤ: Phát hiện thông tin sai lệch, ảo giác AI (hallucinations), mâu thuẫn logic trong lập luận.
`;
}

function getBrandInstructions(brand, rules) {
  const brandRules = rules
    .filter(r => r.type === 'brand')
    .map(r => `- [SOP ${r.label}]: ${r.content}`)
    .join('\n');

  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LAYER 3: BRAND IDENTITY (THƯƠNG HIỆU - 5 CHECKPOINTS)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Dữ liệu gốc từ Brand Profile của ${brand.name}:
1. [BRAND VOICE]: ${brand.voice || brand.tone_of_voice || 'Chưa xác định'}
2. [PERSONALITY]: ${(brand.brand_personality || []).join(', ') || brand.personality || 'Chưa xác định'}
3. [CORE VALUES]: ${(brand.core_values || []).join(', ') || 'Chưa xác định'}
4. [DO WORDS - BẮT BUỘC DÙNG]: ${(brand.do_words || []).join(', ') || 'Không có'}
5. [DON'T WORDS - CẤM DÙNG]: ${(brand.dont_words || []).join(', ') || 'Không có'}

Quy chuẩn SOP bổ sung:
${brandRules || "- Tuyệt đối trung thành với bản sắc thương hiệu."}

NHIỆM VỤ AUDIT KHỐI BRAND:
- Soi lỗi Voice/Tone: Văn bản có quá trang trọng hay quá suồng sã so với Voice quy định không?
- Soi lỗi Personality: Có thể hiện đúng tính cách đã định nghĩa không?
- Soi lỗi Core Values: Nội dung có đi ngược lại hoặc làm sai lệch giá trị cốt lõi không?
- Soi lỗi Từ Ngữ: Kiểm tra triệt để danh sách "Don't Words" và "Do Words".
`;
}

function getProductInstructions(rules, products) {
  const productRules = rules
    .filter(r => r.type === 'product')
    .map(r => `- [SOP ${r.label}]: ${r.content}`)
    .join('\n');

  let productContext = "- Phải nêu đúng lợi ích cốt lõi của giải pháp.";
  
  // Handle array or single object for backward compatibility if needed
  const productList = Array.isArray(products) ? products : (products ? [products] : []);

  if (productList.length > 0) {
    productContext = productList.map((p, index) => `
[SẢN PHẨM ${index + 1}: ${p.name}]
- Tệp khách hàng: ${p.target_audience}
- Công dụng: ${p.benefits}
- USP: ${p.usp}
`).join('\n');
  }

  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LAYER 4: PRODUCT PROFILE (SẢN PHẨM)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${productContext}
- SOP Sản phẩm:
${productRules || "- Không nói sai công dụng hoặc bỏ qua USP quan trọng."}

NHIỆM VỤ: Kiểm tra xem bài viết có đang mô tả sai tính năng, sai USP hoặc nhắm sai đối tượng khách hàng của (các) sản phẩm trên không.
`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { brand, text, platform, language, product, products, rules, platformRules } = req.body;
    
    if (!brand || !text) return res.status(400).json({ error: 'Brand and Text are required' });

    // Use products array if available, otherwise fallback to single product
    const targetProducts = products || product;

    // Assemble the 4-layer prompt on the server side
    const prompt = `
Bạn là Hệ thống MOODBIZ AI Auditor v7.0 (Chuyên gia Soát lỗi & QC).
Nhiệm vụ của bạn là thực hiện đối soát văn bản dựa trên 4 LỚP QUY CHUẨN ĐỘC LẬP. 

PHƯƠNG CHÂM: "Khắt khe - Chính xác - Không bỏ sót lỗi nhỏ". 
Đặc biệt chú trọng lỗi CHÍNH TẢ và HÌNH THỨC ở Layer 1.

${getLanguageInstructions(rules || [], language, platform, platformRules)}
${getLogicInstructions(rules || [])}
${getBrandInstructions(brand, rules || [])}
${getProductInstructions(rules || [], targetProducts)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VĂN BẢN CẦN KIỂM DUYỆT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"${text}"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
YÊU CẦU ĐẦU RA (JSON ONLY)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Hãy phân tích và trả về JSON.
Gán lỗi vào đúng 1 trong 4 category: "language", "ai_logic", "brand", "product".
QUAN TRỌNG: Nếu phát hiện lỗi chính tả, typo, spacing -> Gán vào "language".

{
  "summary": "Tóm tắt ngắn gọn (2-3 dòng) về chất lượng bài viết.",
  "identified_issues": [
    {
      "category": "language | ai_logic | brand | product",
      "problematic_text": "TRÍCH DẪN NGUYÊN VĂN CÂU/TỪ LỖI",
      "citation": "Tên quy tắc vi phạm (Ví dụ: 'Lỗi chính tả', 'Lỗi spacing', 'SOP Brand Voice').",
      "reason": "Giải thích ngắn gọn tại sao sai.",
      "severity": "High | Medium | Low",
      "suggestion": "Viết lại phần bị lỗi cho đúng (Chỉ viết lại cụm từ/câu đó)"
    }
  ]
}
`;

    const apiKey = process.env.GEMINI_API_KEY;
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`;

    const requestBody = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1, // Low temp for precision to catch typos accurately
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

    // Parse JSON result from Gemini
    let jsonResult;
    try {
        jsonResult = JSON.parse(textResult.trim().replace(/```json?/gi, '').replace(/```/g, ''));
    } catch (parseErr) {
        jsonResult = { summary: textResult, identified_issues: [] };
    }

    return res.status(200).json({ result: jsonResult, success: true });
  } catch (e) {
    return res.status(500).json({ error: 'Server error', message: e.message });
  }
};
