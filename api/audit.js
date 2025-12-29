
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

  // Default logic rules if none provided
  const defaultLogic = `
<Rule name="Internal Consistency">The text must not contradict itself (e.g., saying "Free" then "$50").</Rule>
<Rule name="Logical Flow">Arguments and paragraphs must follow a logical sequence.</Rule>
`;

  return `
[LAYER 4: LOGIC & REASONING (AI_LOGIC) - LOWEST PRIORITY]
- Logic Rules: 
${logicRulesFromSOP || defaultLogic}
`;
}

function getBrandInstructions(brand = {}) {
  const personality =
    (Array.isArray(brand.brand_personality) &&
      brand.brand_personality.join(', ')) ||
    brand.personality ||
    'Chưa xác định';

  const coreValues = Array.isArray(brand.core_values) ? brand.core_values.join(', ') : 'N/A';
  const brandUSP = Array.isArray(brand.usp) ? brand.usp.join(', ') : 'N/A';

  return `
[LAYER 2: BRAND STYLE & IDENTITY (BRAND)]
- Voice/Tone: ${brand.voice || brand.tone_of_voice || 'N/A'}
- Personality: ${personality}
- Core Values: ${coreValues}
- Brand USP: ${brandUSP}
- Writing Style Rules: ${brand.style_rules || 'Standard Professional Style'}
- Do Words (Encouraged): ${(Array.isArray(brand.do_words) && brand.do_words.join(', ')) || 'N/A'}
- Don't Words (FORBIDDEN): ${(Array.isArray(brand.dont_words) && brand.dont_words.join(', ')) || 'N/A'}
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
    productContext = 'NO SPECIFIC PRODUCT DATA PROVIDED. Do NOT hallucinate errors about product specs/pricing.';
  }

  return `
[LAYER 3: FACTUAL TRUTH & SEMANTICS (PRODUCT)]
${productContext}
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
    console.warn('JSON Parse Error', error);
    throw error;
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

    console.log(`[Audit Request] Brand: ${brand.name} | Length: ${text.length} | Platform: ${platform}`);

    const safeRules = Array.isArray(rules) ? rules : [];
    const targetProducts = products || product;

    const corePrompt = `
Role: MOODBIZ Auditor v14.0 (Enhanced Classification).
Objective: Identify issues and map them to categories using a PHYSICAL-FIRST approach.

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

3. [CHECK THIRD] FACTUAL TRUTH -> Category: "product"
   * Only check this if Product Data is provided in Layer 3.
   * Are there factual lies about price, specs, or features LISTED in Layer 3?
   => IF MATCH: Category = "product". STOP.

4. [CHECK LAST] REASONING -> Category: "ai_logic"
   * Contradictions within the text?
   * Illogical arguments?
   => IF MATCH: Category = "ai_logic".

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT RULES (JSON ONLY)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Do NOT output issues if the text is correct.
- Do NOT output "Keep as is".
- Category MUST be one of: "language", "ai_logic", "brand", "product".
- Severity MUST be one of: "High", "Medium", "Low".

{
  "summary": "Short summary in Vietnamese.",
  "identified_issues": [
    {
      "category": "language | ai_logic | brand | product",
      "problematic_text": "Exact quote",
      "citation": "Source of rule",
      "reason": "Explain the ROOT CAUSE (e.g., 'Missing punctuation', 'Typo in brand name')",
      "severity": "High | Medium | Low",
      "suggestion": "Correction"
    }
  ]
}
`;

    const apiKey = process.env.GEMINI_API_KEY;
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`;

    const requestBody = {
      contents: [{ parts: [{ text: corePrompt }] }],
      generationConfig: {
        temperature: 0.1,
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
       console.error("Gemini API Error:", errorText);
       throw new Error(`Gemini API returned ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    
    // Safety check for candidates
    if (!data.candidates || data.candidates.length === 0) {
        console.warn("Gemini returned no candidates (possible safety block).");
        return res.status(200).json({ 
            success: true, 
            result: { 
                summary: "Hệ thống AI không trả về kết quả (có thể do nội dung vi phạm chính sách an toàn).", 
                identified_issues: [] 
            } 
        });
    }

    const textResult = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    let jsonResult;

    try {
      jsonResult = safeJSONParse(textResult);

      const VALID_CATEGORIES = ['language', 'ai_logic', 'brand', 'product'];
      
      // Keyword Dictionaries for Classification Refinement
      const LANG_KEYWORDS = [
        'chính tả', 'ngữ pháp', 'dấu câu', 'viết hoa', 'khoảng trắng', 
        'định dạng', 'typo', 'spelling', 'syntax', 'câu cú', 'xuống dòng', 'chấm câu'
      ];
      const BRAND_KEYWORDS = [
        'giọng điệu', 'tone', 'thân mật', 'trang trọng', 'từ cấm', 
        'do words', "don't words", 'thương hiệu', 'style', 'voice', 'xưng hô'
      ];
      const PRODUCT_KEYWORDS = [
        'giá', 'price', 'tính năng', 'feature', 'usp', 'ưu đãi', 
        'gói', 'dịch vụ', 'sản phẩm', 'bảo hành', 'thông số', 'specs'
      ];

      // Tie-breaking Set: Track processed texts to prioritize Language errors
      const processedTexts = new Set();

      if (jsonResult.identified_issues && Array.isArray(jsonResult.identified_issues)) {
        jsonResult.identified_issues = jsonResult.identified_issues
          .map((issue) => {
            // 1. Data Sanitization & Defaults
            if (!issue.problematic_text) return null; // Drop invalid issues
            if (!issue.suggestion) issue.suggestion = "Review text";
            
            // Normalize Severity
            const sev = (issue.severity || '').toLowerCase();
            if (!['high', 'medium', 'low'].includes(sev)) {
                issue.severity = 'Medium';
            } else {
                // Ensure Proper Case
                issue.severity = sev.charAt(0).toUpperCase() + sev.slice(1);
            }

            const cat = issue.category;
            const reason = (issue.reason || '').toLowerCase();
            const citation = (issue.citation || '').toLowerCase();
            const problem = issue.problematic_text.toLowerCase();

            // 2. Advanced Re-routing Logic
            
            // A. Check Language (Physical)
            const looksLikeLanguage = LANG_KEYWORDS.some(k => reason.includes(k) || citation.includes(k));
            if (looksLikeLanguage) {
               return { ...issue, category: 'language' };
            }

            // B. Check Brand (Style) - Re-route from Generic/Logic
            const looksLikeBrand = BRAND_KEYWORDS.some(k => reason.includes(k) || citation.includes(k));
            if (looksLikeBrand && cat === 'ai_logic') {
               return { ...issue, category: 'brand' };
            }

            // C. Check Product (Fact) - Re-route from Logic or misclassified Brand
            const looksLikeProduct = PRODUCT_KEYWORDS.some(k => reason.includes(k) || citation.includes(k) || problem.includes(k));
            if (looksLikeProduct && (cat === 'ai_logic' || cat === 'brand')) {
               return { ...issue, category: 'product' };
            }

            return issue;
          })
          .filter((issue) => {
             // 3. Final Filtering & Deduplication
             if (!issue) return false;

             const category = issue.category;
             const suggestion = (issue.suggestion || '').toLowerCase();
             const prob = (issue.problematic_text || '').trim();
             const sugg = (issue.suggestion || '').trim();
             const reason = (issue.reason || '').toLowerCase();

             // Schema validation
             if (!VALID_CATEGORIES.includes(category)) return false;
             
             // Content validation
             if (suggestion.includes('giữ nguyên') || suggestion.includes('keep as is') || !suggestion) return false;
             if (prob && sugg && prob.toLowerCase() === sugg.toLowerCase()) return false;
             if (reason.includes('đúng') || reason.includes('tốt') || reason.includes('không có lỗi')) return false;

             // Tie-breaking: Prioritize Language (Physical) over others
             // If we already have a Language error for this exact text, skip other errors for it.
             const key = prob.toLowerCase();
             
             // If this issue IS Language, we keep it and mark text as processed
             if (category === 'language') {
                processedTexts.add(key);
                return true;
             }

             // If text was already processed by a Language error, skip this non-language error
             if (processedTexts.has(key)) {
                return false;
             }

             return true;
          });
      }
    } catch (parseErr) {
      console.error('JSON Parse Error:', parseErr);
      console.log('Raw Text:', textResult);
      jsonResult = {
        summary: 'Lỗi xử lý phản hồi từ AI (JSON Parse Error).',
        identified_issues: [],
      };
    }

    return res.status(200).json({ result: jsonResult, success: true });
  } catch (e) {
    console.error('Audit API Error:', e);
    // Return a structured error response instead of 500 crash where possible
    return res.status(200).json({ 
        success: false, 
        result: { 
            summary: `Hệ thống gặp sự cố: ${e.message}`, 
            identified_issues: [] 
        } 
    });
  }
};
