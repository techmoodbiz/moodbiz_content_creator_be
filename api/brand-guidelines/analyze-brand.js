import * as cheerio from "cheerio";

export default async function handler(req, res) {
    // CORS
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET,OPTIONS,PATCH,DELETE,POST,PUT"
    );
    res.setHeader(
        "Access-Control-Allow-Headers",
        "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization"
    );

    if (req.method === "OPTIONS") {
        res.status(200).end();
        return;
    }

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        const { websiteUrl } = req.body;

        if (!websiteUrl) {
            return res.status(400).json({ error: "Website URL is required" });
        }

        // Validate URL
        let url;
        try {
            url = new URL(websiteUrl);
        } catch (e) {
            return res.status(400).json({ error: "Invalid URL format" });
        }

        console.log(`Analyzing brand from: ${websiteUrl}`);

        // STEP 1: fetch website
        const response = await fetch(websiteUrl, {
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
            },
        });

        if (!response.ok) {
            return res.status(400).json({
                error: `Website chặn bot (status ${response.status}). Vui lòng chọn website khác hoặc nhập brief tay.`,
            });
        }

        const html = await response.text();
        const $ = cheerio.load(html);

        // STEP 2: Extract basic information (giữ logic gốc)
        const extractedData = {
            title: $("title").text() || "",
            metaDescription: $('meta[name="description"]').attr("content") || "",
            metaKeywords: $('meta[name="keywords"]').attr("content") || "",
            ogTitle: $('meta[property="og:title"]').attr("content") || "",
            ogDescription: $('meta[property="og:description"]').attr("content") || "",
            mainText: "",
            aboutText: "",
            headings: [],
        };

        // Main text
        $("p, h1, h2, h3, li").each((i, elem) => {
            if (i < 50) {
                const text = $(elem).text().trim();
                if (text.length > 10) {
                    extractedData.mainText += text + " ";
                }
            }
        });

        // About section
        $("section, div, article").each((i, elem) => {
            const text = $(elem).text();
            const innerHtml = $(elem).html() || "";
            if (
                innerHtml.toLowerCase().includes("about") ||
                text.toLowerCase().includes("about us") ||
                text.toLowerCase().includes("về chúng tôi")
            ) {
                extractedData.aboutText += $(elem).text().substring(0, 1000) + " ";
            }
        });

        // Headings
        $("h1, h2, h3").each((i, elem) => {
            if (i < 10) {
                extractedData.headings.push($(elem).text().trim());
            }
        });

        // Trim to avoid token limits
        extractedData.mainText = extractedData.mainText.substring(0, 3000);
        extractedData.aboutText = extractedData.aboutText.substring(0, 1500);

        console.log("Extracted data:", {
            title: extractedData.title,
            textLength: extractedData.mainText.length,
            aboutLength: extractedData.aboutText.length,
            headings: extractedData.headings.length,
        });

        // STEP 3: Call Gemini via REST API (giống audit.js)
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            console.error("GEMINI_API_KEY not found in environment");
            return res.status(500).json({ error: "API key not configured" });
        }

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

        const prompt = `
Analyze the following website content and extract brand guideline information.

Return ONLY a valid JSON object with EXACTLY these camelCase keys:
{
  "brandName": "Company/Brand name",
  "industry": "Industry/Sector",
  "targetAudience": "Target audience description",
  "tone": "Communication tone (formal/casual/friendly/professional)",
  "coreValues": ["Value 1", "Value 2", "Value 3"],
  "keywords": ["keyword1", "keyword2", "keyword3"],
  "visualStyle": "Description of visual style",
  "dos": ["Do this", "Do that"],
  "donts": ["Don't do this", "Don't do that"],
  "summary": "Brief brand summary"
}

Do NOT add, remove, or rename any keys. Use exactly these key names.

Website Data:
- Title: ${extractedData.title}
- Meta Description: ${extractedData.metaDescription}
- Main Content: ${extractedData.mainText}
- About Section: ${extractedData.aboutText}
- Key Headings: ${extractedData.headings.join(" | ")}
`;

        const requestBody = {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 8192,
                responseMimeType: "application/json",
            },
        };

        console.log("Calling Gemini API for analyze-brand...");
        const aiRes = await fetch(geminiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
        });

        if (!aiRes.ok) {
            const errorText = await aiRes.text();
            console.error("Gemini API error (analyze-brand):", aiRes.status, errorText);
            return res.status(aiRes.status).json({
                error: "Gemini API error",
                status: aiRes.status,
                details: errorText,
            });
        }

        const data = await aiRes.json();
        const textResult = data.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!textResult) {
            console.error("No text result from Gemini (analyze-brand)");
            return res.status(500).json({ error: "No response from AI" });
        }

        // Clean & parse JSON
        let brandGuideline = null;
        try {
            const cleaned = textResult
                .trim()
                .replace(/```json?/gi, '')
                .replace(/```/g, '')
                .replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F]/g, '');
            brandGuideline = JSON.parse(cleaned);
        } catch (parseError) {
            console.warn("ANALYZE JSON parse failed at BE:", parseError.message);
            return res.status(500).json({
                error: "Failed to parse AI response",
                details: parseError.message,
                rawResponse: textResult,
            });
        }

        console.log(
            "ANALYZE brandGuideline:",
            JSON.stringify(brandGuideline, null, 2)
        );

        // Normalize schema + metadata
        const responseData = {
            brandName:
                brandGuideline?.brandName ||
                brandGuideline?.brand_name ||
                brandGuideline?.name ||
                extractedData.title ||
                "",

            industry: brandGuideline?.industry || "",
            targetAudience:
                brandGuideline?.targetAudience ||
                brandGuideline?.target_audience ||
                "",
            tone: brandGuideline?.tone || "",
            coreValues:
                brandGuideline?.coreValues ||
                brandGuideline?.core_values ||
                [],
            keywords: brandGuideline?.keywords || [],
            visualStyle:
                brandGuideline?.visualStyle ||
                brandGuideline?.visual_style ||
                "",
            dos: brandGuideline?.dos || [],
            donts: brandGuideline?.donts || [],
            summary: brandGuideline?.summary || "",

            sourceUrl: websiteUrl,
            analyzedAt: new Date().toISOString(),
            method: "autogenerated",
            confidence: "medium",
        };

        console.log(
            "ANALYZE responseData:",
            JSON.stringify(responseData, null, 2)
        );
        console.log("Successfully analyzed brand:", responseData.brandName);

        return res.status(200).json({ success: true, data: responseData });
    } catch (error) {
        console.error("Error analyzing brand:", error);
        return res.status(500).json({
            error: "Failed to analyze brand",
            details: error.message,
        });
    }
}
