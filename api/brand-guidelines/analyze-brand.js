
import * as cheerio from "cheerio";

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization");

    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        const { websiteUrl } = req.body;

        if (!websiteUrl) {
            return res.status(400).json({ error: "Website URL is required" });
        }

        let url;
        try {
            url = new URL(websiteUrl);
        } catch (e) {
            return res.status(400).json({ error: "Invalid URL format" });
        }

        const response = await fetch(websiteUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
            },
        });

        if (!response.ok) {
            return res.status(400).json({
                error: `Website chặn bot (status ${response.status}). Vui lòng chọn website khác hoặc nhập brief tay.`,
            });
        }

        const html = await response.text();
        const $ = cheerio.load(html);

        const extractedData = {
            title: $("title").text() || "",
            metaDescription: $('meta[name="description"]').attr("content") || "",
            mainText: "",
            aboutText: "",
            headings: [],
        };

        $("p, h1, h2, h3, li").each((i, elem) => {
            if (i < 50) {
                const text = $(elem).text().trim();
                if (text.length > 10) {
                    extractedData.mainText += text + " ";
                }
            }
        });

        $("h1, h2, h3").each((i, elem) => {
            if (i < 10) {
                extractedData.headings.push($(elem).text().trim());
            }
        });

        extractedData.mainText = extractedData.mainText.substring(0, 3000);

        const apiKey = process.env.GEMINI_API_KEY;
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`;

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
Website Data:
- Title: ${extractedData.title}
- Meta Description: ${extractedData.metaDescription}
- Main Content: ${extractedData.mainText}
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

        const aiRes = await fetch(geminiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
        });

        if (!aiRes.ok) {
            const errorText = await aiRes.text();
            return res.status(aiRes.status).json({ error: "Gemini API error", details: errorText });
        }

        const data = await aiRes.json();
        const textResult = data.candidates?.[0]?.content?.parts?.[0]?.text;

        let brandGuideline = JSON.parse(textResult.trim().replace(/```json?/gi, '').replace(/```/g, ''));

        return res.status(200).json({ success: true, data: brandGuideline });
    } catch (error) {
        return res.status(500).json({
            error: "Failed to analyze brand",
            details: error.message,
        });
    }
}
