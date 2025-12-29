
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
[LAYER 3 DATA: TECHNICAL STANDARDS]
- Platform: ${platform} (${platformRules || 'Standard'})
- Language Rules: ${langRules || '(Standard Grammar)'}
`;
}

function getLogicInstructions(rules) {
  const safeRules = Array.isArray(rules) ? rules : [];

  const logicRulesFromSOP = safeRules
    .filter((r) => r.type === 'ai_logic')
    .map((r) => `<Rule name="${r.label}">\n${r.content}\n</Rule>`)
    .join('\n');

  return `
[LAYER 4 DATA: LOGIC & REASONING]
- Logic Rules: ${logicRulesFromSOP || '(Internal Consistency)'}
`;
}

function getBrandInstructions(brand = {}) {
  const personality =
    (Array.isArray(brand.brand_personality) &&
      brand.brand_personality.join(', ')) ||
    brand.personality ||
    'Chưa xác định';

  return `
[LAYER 2 DATA: BRAND IDENTITY]
- Voice/Tone: ${brand.voice || brand.tone_of_voice || 'N/A'}
- Personality: ${personality}
- Do Words: ${
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

  let productContext =
    'No specific product selected. Only check general product logic.';

  if (productList.length > 0) {
    productContext = productList
      .map(
        (p, index) => `
[ITEM ${index + 1}]
- Name: ${p.name}
- Target Audience: ${p.target_audience}
- Benefits: ${p.benefits}
- USP: ${p.usp}
`,
      )
      .join('\n');
  }

  return `
[LAYER 1 DATA: PRODUCT FACTS (HIGHEST PRIORITY)]
${productContext}
`;
}

// Robust JSON parsing helper
function safeJSONParse(text) {
  try {
    let cleaned = text.trim();
    // FIX: Regex cũ bị sai (/``````/), thay bằng regex bắt markdown block chuẩn
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

    const safeRules = Array.isArray(rules) ? rules : [];
    const targetProducts = products || product;

    const corePrompt = `
Role: MOODBIZ Auditor v12.1 (Decision Tree Mode).
Objective: Identify issues in the text using a strict PRIORITY FILTER.

INPUT DATA:
${getProductInstructions(targetProducts)}
${getBrandInstructions(brand)}
${getLanguageInstructions(safeRules, language, platform, platformRules)}
${getLogicInstructions(safeRules)}

TEXT TO AUDIT:
"${text}"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DECISION TREE ALGORITHM (MUST FOLLOW IN ORDER)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
For each potential issue found, apply these checks sequentially. STOP at the first match.

1️⃣ [PRIORITY 1] CHECK "product"
   - Is it a factual error about Product Features, Pricing, or Specs?
   - Is it mentioning a competitor or feature NOT in the Input?
   - Is the USP missing or wrong?
   - Is the Target Audience clearly wrong?
   => IF YES: Category = "product". STOP.

2️⃣ [PRIORITY 2] CHECK "brand"
   - Does it use any "Don't Words"?
   - Is the Tone/Voice wrong (e.g., too casual for a professional brand)?
   - Is the Personality inconsistent with the profile?
   => IF YES: Category = "brand". STOP.

3️⃣ [PRIORITY 3] CHECK "language"
   - Are there spelling or grammar mistakes?
   - Are there formatting issues (spacing, capitalization, punctuation)?
   - Does it violate Platform specific rules (length, structure)?
   => IF YES: Category = "language". STOP.

4️⃣ [PRIORITY 4] CHECK "ai_logic"
   - Is there a contradiction within the text itself (e.g., says "Free" then says "$50")?
   - Is the reasoning weak or nonsensical?
   - Is there a hallucination about general world knowledge (NOT product facts)?
   => IF YES: Category = "ai_logic".

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT RULES (JSON ONLY)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Do NOT output issues if the text is correct.
- Do NOT output "Keep as is" suggestions.
- Do NOT duplicate issues.
- Category MUST be one of: "language", "ai_logic", "brand", "product".

{
  "summary": "Short summary in Vietnamese.",
  "identified_issues": [
    {
      "category": "language | ai_logic | brand | product",
      "problematic_text": "Exact quote",
      "citation": "Source of rule (e.g., 'Product Specs', 'Brand Voice', 'Grammar Rule')",
      "reason": "Why is it wrong based on the data?",
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

    const data = await response.json();
    const textResult =
      data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    let jsonResult;
    try {
      jsonResult = safeJSONParse(textResult);

      const VALID_CATEGORIES = ['language', 'ai_logic', 'brand', 'product'];

      if (jsonResult.identified_issues && Array.isArray(jsonResult.identified_issues)) {
        jsonResult.identified_issues = jsonResult.identified_issues.filter(
          (issue) => {
            const category = issue.category;
            const suggestion = (issue.suggestion || '').toLowerCase();
            const prob = (issue.problematic_text || '').trim();
            const sugg = (issue.suggestion || '').trim();
            const reason = (issue.reason || '').toLowerCase();

            // 1) Category phải hợp lệ
            if (!VALID_CATEGORIES.includes(category)) return false;

            // 2) Suggestion vô nghĩa
            if (
              suggestion.includes('giữ nguyên') ||
              suggestion.includes('keep as is') ||
              !suggestion
            )
              return false;

            // 3) Suggestion trùng đoạn gốc
            if (prob && sugg && prob === sugg) return false;

            // 4) Reason là lời khen
            if (
              reason.includes('đúng') ||
              reason.includes('tốt') ||
              reason.includes('phù hợp') ||
              reason.includes('chuẩn') ||
              reason.includes('không có lỗi') ||
              reason.includes('không phát hiện lỗi')
            )
              return false;

            return true;
          },
        );
      }
    } catch (parseErr) {
      console.error('JSON Parse Error:', parseErr);
      jsonResult = {
        summary: 'Lỗi xử lý phản hồi từ AI.',
        identified_issues: [],
      };
    }

    return res.status(200).json({ result: jsonResult, success: true });
  } catch (e) {
    console.error('Audit API Error:', e);
    return res
      .status(500)
      .json({ error: 'Server error', message: e.message });
  }
};
