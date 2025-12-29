
const fetch = require('node-fetch');

// --- HELPER: PROMPT TEMPLATES ---

function getLanguageInstructions(rules, language, platform, platformRules) {
  const targetLang =
    language === 'Vietnamese'
      ? 'vi'
      : language === 'English'
      ? 'en'
      : language === 'Japanese'
      ? 'ja'
      : language;

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
    .map((r) => `<Rule name="${r.label}">\n${r.content}\n</Rule>`)
    .join('\n');

  return `
[LAYER 1: PHYSICAL & SYNTAX STANDARDS (LANGUAGE) - HIGHEST PRIORITY]
- Target Language: ${language}
- Platform Rules: ${platform} (${platformRules || 'Standard formatting'})
- Grammar/Spelling Rules: ${langRules || '(Standard Grammar & Spacing)'}
`;
}

function getLogicInstructions(rules) {
  const safeRules = Array.isArray(rules) ? rules : [];

  const logicRulesFromSOP = safeRules
    .filter((r) => r.type === 'ai_logic')
    .map((r) => `<Rule name="${r.label}">\n${r.content}\n</Rule>`)
    .join('\n');

  const defaultLogic = `
<Rule name="Internal Consistency">The text must not contradict itself (e.g., saying "Free" then "$50").</Rule>
<Rule name="Logical Flow">Arguments and paragraphs must follow a logical sequence.</Rule>
`;

  return `
[LAYER 4: LOGIC & REASONING (AI_LOGIC) - LOWEST PRIORITY]
- Logic Rules: 
${logicRulesFromSOP || defaultLogic}

[HALLUCINATION CHECK - AI_LOGIC]
- Hallucination = thông tin KHÔNG có trong INPUT DATA mà model tự bịa ra, hoặc mâu thuẫn với kiến thức phổ quát (marketing, business, đời sống).
- Nếu thông tin bịa đặt liên quan trực tiếp đến sản phẩm/dịch vụ cụ thể (giá, tính năng, gói, ưu đãi, đối tượng sử dụng) → gán category "product", KHÔNG gán "ai_logic".
- Nếu thông tin bịa đặt là kiến thức chung (định nghĩa, concept, xu hướng, số liệu thị trường...) → gán category "ai_logic".
- Không gán "ai_logic" cho lỗi chính tả, giọng văn hay sai fact sản phẩm.
`;
}

function getBrandInstructions(brand = {}) {
  const personality =
    (Array.isArray(brand.brand_personality) &&
      brand.brand_personality.join(', ')) ||
    brand.personality ||
    'Chưa xác định';

  const coreValues = Array.isArray(brand.core_values)
    ? brand.core_values.join(', ')
    : 'N/A';
  const brandUSP = Array.isArray(brand.usp)
    ? brand.usp.join(', ')
    : 'N/A';

  return `
[LAYER 2: BRAND STYLE & IDENTITY (BRAND)]
- Voice/Tone: ${brand.voice || brand.tone_of_voice || 'N/A'}
- Personality: ${personality}
- Core Values: ${coreValues}
- Brand USP: ${brandUSP}
- Writing Style Rules: ${brand.style_rules || 'Standard Professional Style'}
- Do Words (Encouraged): ${
    (Array.isArray(brand.do_words) && brand.do_words.join(', ')) || 'N/A'
  }
- Don't Words (FORBIDDEN): ${
    (Array.isArray(brand.dont_words) && brand.dont_words.join(', ')) || 'N/A'
  }
`;
}

function getProductInstructions(products) {
  const productList = Array.isArray(products)
    ? products
    : products
    ? [products]
    : [];

  let productContext = '';

  if (productList.length > 0) {
    productContext = productList
      .map(
        (p, index) => `
[ITEM ${index + 1}]
- Name: ${p.name}
- Target Audience: ${p.target_audience}
- Benefits: ${p.benefits}
- Product USP: ${p.usp}
`,
      )
      .join('\n');
  } else {
    productContext =
      'NO SPECIFIC PRODUCT DATA PROVIDED. Do NOT hallucinate errors about product specs/pricing.';
  }

  return `
[LAYER 3: FACTUAL TRUTH & SEMANTICS (PRODUCT)]
${productContext}
`;
}

// Robust JSON parsing helper with improved repair logic
function safeJSONParse(text) {
  // Helper to remove markdown block markers
  const stripMarkdown = (str) => {
    const match = str.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    return match ? match[1] : str;
  };

  let candidate = stripMarkdown(text).trim();

  // Attempt 1: Strict Parse (Best Case)
  try {
    return JSON.parse(candidate);
  } catch (e) {
    // Attempt 2: Extract strictly between first { and last } to handle trailing garbage text
    const firstOpen = candidate.indexOf('{');
    const lastClose = candidate.lastIndexOf('}');
    
    if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
       const sub = candidate.substring(firstOpen, lastClose + 1);
       try {
         return JSON.parse(sub);
       } catch (e2) {
         // If exact extraction fails, fall through to repair using the extracted substring
         candidate = sub; 
       }
    } else if (firstOpen !== -1) {
       // Only start brace exists (Truncated response)
       candidate = candidate.substring(firstOpen);
    }
  }

  // Attempt 3: Aggressive Repair for Truncation
  try {
      // Remove trailing comma (common in truncated lists)
      if (candidate.trim().endsWith(',')) candidate = candidate.trim().slice(0, -1);
      
      // Balance quotes
      if ((candidate.match(/"/g) || []).length % 2 !== 0) candidate += '"';
      
      // Balance brackets/braces
      const openBrackets = (candidate.match(/\[/g) || []).length;
      const closeBrackets = (candidate.match(/]/g) || []).length;
      const openBraces = (candidate.match(/{/g) || []).length;
      const closeBraces = (candidate.match(/}/g) || []).length;

      for (let i = 0; i < openBrackets - closeBrackets; i++) candidate += ']';
      for (let i = 0; i < openBraces - closeBraces; i++) candidate += '}';

      return JSON.parse(candidate);
  } catch (finalError) {
      console.error("JSON Repair Failed:", finalError.message);
      // Return a safe fallback object to prevent crash
      return {
          summary: "Lỗi: Phản hồi từ AI bị lỗi format hoặc cắt ngắn.",
          identified_issues: [],
          _raw_error: finalError.message
      };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization',
  );

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

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

    console.log(
      `[Audit Request] Brand: ${brand.name} | Length: ${text.length} | Platform: ${platform}`,
    );

    const safeRules = Array.isArray(rules) ? rules : [];
    const targetProducts = products || product;

    const corePrompt = `
Role: MOODBIZ Auditor v14.1 (Hallucination-Aware, Surface-First).
Objective: Identify issues and map them to categories using a PHYSICAL-FIRST approach, with special attention to AI hallucinations.

INPUT DATA:
${getLanguageInstructions(safeRules, language, platform, platformRules)}
${getBrandInstructions(brand)}
${getProductInstructions(targetProducts)}
${getLogicInstructions(safeRules)}

TEXT TO AUDIT:
"${text}"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PRIORITY ROUTING (STRICT ORDER - TIE BREAKING)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Check for errors in this EXACT order. If a text segment has multiple errors, report only the highest priority one.

1. [CHECK FIRST] PHYSICAL ERRORS -> Category: "language"
   * Is there ANY spelling error (typo), capitalization error, or spacing error?
   * Is there ANY missing punctuation (periods, commas) or wrong format?
   * CRITICAL: Even if the typo is in a Product Name (e.g., "Iphne"), it is a LANGUAGE error.
   * CRITICAL: Even if missing punctuation makes the sentence feel incomplete, it is a LANGUAGE error (Syntax), NOT Logic.
   => IF MATCH: Category = "language". STOP processing this specific text segment.

2. [CHECK SECOND] STYLE & IDENTITY -> Category: "brand"
   * Does it violate "Writing Style Rules" defined in Layer 2?
   * Does it use "Don't Words"?
   * Is the Tone/Voice inconsistent with the Brand Profile?
   => IF MATCH: Category = "brand". STOP.

3. [CHECK THIRD] FACTUAL TRUTH (PRODUCT) -> Category: "product"
   * Only check this if Product Data is provided in Layer 3.
   * Are there factual lies about price, specs, or features LISTED in Layer 3?
   * If hallucination is about product-specific info (price, features, package, offer, audience) → Category = "product".
   => IF MATCH: Category = "product". STOP.

4. [CHECK LAST] REASONING & GENERAL HALLUCINATION -> Category: "ai_logic"
   * Contradictions within the text (e.g., Time paradoxes, Self-contradiction)?
   * Illogical or nonsense arguments?
   * Hallucinated citations or general knowledge (NOT product-specific)?
   => IF MATCH: Category = "ai_logic".

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SUMMARY GENERATION GUIDELINES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Draft a professional Executive Summary (in Vietnamese) that follows this structure:
1. Verdict: Start with a clear assessment (e.g., "Nội dung tốt", "Cần chỉnh sửa", "Rủi ro cao").
2. Key Issues: Mention the specific layer with the most critical errors (e.g., "Vi phạm nghiêm trọng Brand Voice" or "Sai thông tin sản phẩm").
3. Action: Give 1 specific recommendation.
* Tone: Objective, Professional, Constructive.
* Length: Max 2-3 sentences.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT RULES (JSON ONLY)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Do NOT output issues if the text is correct.
- Do NOT output "Keep as is".
- Category MUST be one of: "language", "ai_logic", "brand", "product".
- Severity MUST be one of: "High", "Medium", "Low".

{
  "summary": "Verdict + Key Issues + Action (Executive Summary in Vietnamese).",
  "identified_issues": [
    {
      "category": "language | ai_logic | brand | product",
      "problematic_text": "Exact quote",
      "citation": "Source of rule",
      "reason": "Explain the ROOT CAUSE (e.g., 'Missing punctuation', 'Typo in brand name', 'Hallucinated market definition')",
      "severity": "High | Medium | Low",
      "suggestion": "Correction"
    }
  ]
}
`;

    // Use GEMINI_API_KEY from environment variables (Server-Side)
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

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Gemini API Error:', errorText);
      throw new Error(`Gemini API returned ${response.status}: ${errorText}`);
    }

    const data = await response.json();

    if (!data.candidates || data.candidates.length === 0) {
      console.warn('Gemini returned no candidates (possible safety block).');
      return res.status(200).json({
        success: true,
        result: {
          summary:
            'Hệ thống AI không trả về kết quả (có thể do nội dung vi phạm chính sách an toàn).',
          identified_issues: [],
        },
      });
    }

    const textResult =
      data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    let jsonResult;

    try {
      jsonResult = safeJSONParse(textResult);

      // --- Post Processing & Classification Refinement ---
      const VALID_CATEGORIES = ['language', 'ai_logic', 'brand', 'product'];

      const LANG_KEYWORDS = [
        'chính tả', 'ngữ pháp', 'dấu câu', 'viết hoa', 'khoảng trắng', 'định dạng', 
        'typo', 'spelling', 'syntax', 'câu cú', 'xuống dòng', 'chấm câu'
      ];
      const BRAND_KEYWORDS = [
        'giọng điệu', 'tone', 'thân mật', 'trang trọng', 'từ cấm', 
        'do words', "don't words", 'thương hiệu', 'style', 'voice', 'xưng hô'
      ];
      const PRODUCT_KEYWORDS = [
        'giá', 'price', 'tính năng', 'feature', 'usp', 'ưu đãi', 'gói', 
        'dịch vụ', 'sản phẩm', 'bảo hành', 'thông số', 'specs', 'gói dịch vụ'
      ];
      const HALLU_KEYWORDS = [
        'bịa đặt', 'hallucination', 'tự suy diễn', 'không có trong dữ liệu', 
        'không có trong input', 'sai kiến thức', 'bịa thông tin', 'fake source', 'nguồn giả'
        // Note: Removed generic 'trích dẫn', 'nguồn' to avoid false positives on 'missing citation' (Brand issue)
      ];
      
      // Keywords for explicit Logic/Time errors that should NOT be Product
      const LOGIC_KEYWORDS = [
        'logic', 'mâu thuẫn', 'thời gian', 'tương lai', 'quá khứ', 'contradict', 
        'không hợp lý', 'ngày tháng', 'năm', '2024', '2025', '2026', 'nghịch lý'
      ];

      const processedTexts = new Set();

      if (
        jsonResult.identified_issues &&
        Array.isArray(jsonResult.identified_issues)
      ) {
        jsonResult.identified_issues = jsonResult.identified_issues
          .map((issue) => {
            if (!issue.problematic_text) return null;

            if (!issue.suggestion) issue.suggestion = 'Review text';

            const sev = (issue.severity || '').toLowerCase();
            if (!['high', 'medium', 'low'].includes(sev)) {
              issue.severity = 'Medium';
            } else {
              issue.severity =
                sev.charAt(0).toUpperCase() + sev.slice(1);
            }

            const cat = issue.category;
            const reason = (issue.reason || '').toLowerCase();
            const citation = (issue.citation || '').toLowerCase();
            const problem = (issue.problematic_text || '').toLowerCase();

            const looksLikeLanguage = LANG_KEYWORDS.some(
              (k) => reason.includes(k) || citation.includes(k),
            );

            const looksLikeBrand = BRAND_KEYWORDS.some(
              (k) => reason.includes(k) || citation.includes(k),
            );

            const looksLikeProduct = PRODUCT_KEYWORDS.some(
              (k) =>
                reason.includes(k) ||
                citation.includes(k) ||
                problem.includes(k),
            );

            const looksLikeHallucination = HALLU_KEYWORDS.some(
              (k) => reason.includes(k) || citation.includes(k),
            );
            
            const looksLikeLogic = LOGIC_KEYWORDS.some(
              (k) => reason.includes(k) || citation.includes(k)
            );

            // A. LANGUAGE always priority
            if (looksLikeLanguage) {
              return { ...issue, category: 'language' };
            }

            // B. FORCE AI LOGIC
            // If it is explicitly a logic/time error, Force AI_LOGIC.
            if (looksLikeLogic) {
               return { ...issue, category: 'ai_logic' };
            }

            // C. HALLUCINATION PROTECTION
            // If it's a hallucination and NOT clearly about product specs, keep in AI_LOGIC
            if (looksLikeHallucination && cat === 'ai_logic' && !looksLikeProduct) {
               return { ...issue, category: 'ai_logic' };
            }

            // D. BRAND: re-route from ai_logic if purely tone/style
            if (
              looksLikeBrand &&
              cat === 'ai_logic' &&
              !looksLikeProduct &&
              !looksLikeHallucination
            ) {
              return { ...issue, category: 'brand' };
            }

            // E. PRODUCT: Fact error about product
            if (
              looksLikeProduct &&
              (cat === 'ai_logic' || cat === 'brand')
            ) {
              return { ...issue, category: 'product' };
            }

            return issue;
          })
          .filter((issue) => {
            if (!issue) return false;

            const category = issue.category;
            const suggestion = (issue.suggestion || '').toLowerCase();
            const prob = (issue.problematic_text || '').trim();
            const sugg = (issue.suggestion || '').trim();

            if (!VALID_CATEGORIES.includes(category)) return false;

            if (
              suggestion.includes('giữ nguyên') ||
              suggestion.includes('keep as is') ||
              !suggestion
            )
              return false;

            if (
              prob &&
              sugg &&
              prob.toLowerCase() === sugg.toLowerCase()
            )
              return false;

            const key = prob.toLowerCase();

            if (category === 'language') {
              processedTexts.add(key);
              return true;
            }

            if (processedTexts.has(key)) {
              return false;
            }

            return true;
          });
      }

      jsonResult.version = 'v14.1-server-stable';
    } catch (parseErr) {
      console.error('JSON Parse Error:', parseErr);
      console.log('Raw Text:', textResult);
      jsonResult = {
        summary: 'Lỗi xử lý phản hồi từ AI (JSON Parse Error).',
        identified_issues: [],
        version: 'v14.1-server',
      };
    }

    return res.status(200).json({ result: jsonResult, success: true });
  } catch (e) {
    console.error('Audit API Error:', e);
    // Return 500 status code for server errors so frontend/monitoring can track it
    return res.status(500).json({
      success: false,
      error: e.message,
      result: {
        summary: `Hệ thống gặp sự cố: ${e.message}`,
        identified_issues: [],
        version: 'v14.1-server-error',
      },
    });
  }
};
