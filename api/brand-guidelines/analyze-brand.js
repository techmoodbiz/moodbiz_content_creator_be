
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

        // Remove script, style, and hidden elements to reduce noise
        $('script, style, noscript, iframe, svg').remove();

        const extractedData = {
            title: $("title").text() || "",
            metaDescription: $('meta[name="description"]').attr("content") || "",
            mainText: "",
            headings: [],
        };

        // Improved Text Extraction: Get more content
        $("body").find("p, h1, h2, h3, h4, li, blockquote").each((i, elem) => {
            const text = $(elem).text().trim().replace(/\s+/g, " ");
            if (text.length > 20) {
                extractedData.mainText += text + "\n";
            }
        });

        $("h1, h2, h3").each((i, elem) => {
             const text = $(elem).text().trim();
             if (text) extractedData.headings.push(text);
        });

        // Increase context limit significantly for Gemini Flash (supports ~1M tokens, so 50k chars is safe)
        const contentContext = `
TITLE: ${extractedData.title}
DESCRIPTION: ${extractedData.metaDescription}
HEADINGS: ${extractedData.headings.join(" | ")}
CONTENT SAMPLE:
${extractedData.mainText.substring(0, 50000)}
        `;

        const apiKey = process.env.GEMINI_API_KEY;
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

        const prompt = `
You are a Brand Strategist AI. Analyze the website content below to reverse-engineer the Brand Guideline.

IMPORTANT: If explicit rules (like "Don'ts") are not written, you must INFER them based on the writing style.
- If the tone is "Professional/Corporate", implied Don'ts are "Slang, Emojis, Casual jokes".
- If the tone is "Playful/GenZ", implied Dos are "Emojis, Trending slang".

Extract the following:
1. Brand Name & Industry.
2. Target Audience (Who is this for?).
3. Tone of Voice (Adjectives describing the vibe).
4. Core Values (What matters to them?).
5. Visual Style (Infer from descriptions of images/colors if any, or general vibe).
6. Do Words (Words/Phrases they use often).
7. Don't Words (Words/Phrases that would feel out of place).
`;

        const requestBody = {
            contents: [{ parts: [{ text: prompt + "\n\n" + contentContext }] }],
            generationConfig: {
                temperature: 0.5,
                responseMimeType: "application/json",
                // DEFINING SCHEMA FOR RELIABILITY
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        brandName: { type: "STRING" },
                        industry: { type: "STRING" },
                        targetAudience: { type: "STRING" },
                        tone: { type: "STRING" },
                        coreValues: { type: "ARRAY", items: { type: "STRING" } },
                        keywords: { type: "ARRAY", items: { type: "STRING" } },
                        visualStyle: { type: "STRING" },
                        dos: { type: "ARRAY", items: { type: "STRING" } },
                        donts: { type: "ARRAY", items: { type: "STRING" } },
                        summary: { type: "STRING" }
                    },
                    required: ["brandName", "tone", "dos", "donts", "summary"]
                }
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
        // With responseSchema, we don't need regex cleanup. The text IS valid JSON.
        const brandGuideline = JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text || "{}");

        return res.status(200).json({ success: true, data: brandGuideline });
    } catch (error) {
        return res.status(500).json({
            error: "Failed to analyze brand",
            details: error.message,
        });
    }
}
