import { GoogleGenerativeAI } from '@google/generative-ai';
import * as cheerio from 'cheerio';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader(
        'Access-Control-Allow-Methods',
        'GET,OPTIONS,PATCH,DELETE,POST,PUT'
    );
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
    );

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { websiteUrl } = req.body;

        if (!websiteUrl) {
            return res.status(400).json({ error: 'Website URL is required' });
        }

        // Validate URL
        let url;
        try {
            url = new URL(websiteUrl);
        } catch (e) {
            return res.status(400).json({ error: 'Invalid URL format' });
        }

        console.log(`Analyzing brand from: ${websiteUrl}`);

        // Step 1: Fetch website content
        const response = await fetch(websiteUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch website: ${response.status} ${response.statusText}`);
        }

        const html = await response.text();
        const $ = cheerio.load(html);

        // Step 2: Extract basic information
        const extractedData = {
            title: $('title').text() || '',
            metaDescription: $('meta[name="description"]').attr('content') || '',
            metaKeywords: $('meta[name="keywords"]').attr('content') || '',
            ogTitle: $('meta[property="og:title"]').attr('content') || '',
            ogDescription: $('meta[property="og:description"]').attr('content') || '',

            // Extract text content from main areas
            mainText: '',
            aboutText: '',

            // Extract headings for understanding structure
            headings: []
        };

        // Get main content text (limit to avoid token limits)
        $('p, h1, h2, h3, li').each((i, elem) => {
            if (i < 50) { // Limit items
                const text = $(elem).text().trim();
                if (text.length > 10) {
                    extractedData.mainText += text + ' ';
                }
            }
        });

        // Look for About Us section
        $('section, div, article').each((i, elem) => {
            const text = $(elem).text();
            const html = $(elem).html() || '';
            if (html.toLowerCase().includes('about') ||
                text.toLowerCase().includes('about us') ||
                text.toLowerCase().includes('về chúng tôi')) {
                extractedData.aboutText += $(elem).text().substring(0, 1000) + ' ';
            }
        });

        // Get all headings
        $('h1, h2, h3').each((i, elem) => {
            if (i < 10) {
                extractedData.headings.push($(elem).text().trim());
            }
        });

        // Trim text to avoid token limits
        extractedData.mainText = extractedData.mainText.substring(0, 3000);
        extractedData.aboutText = extractedData.aboutText.substring(0, 1500);

        console.log('Extracted data:', {
            title: extractedData.title,
            textLength: extractedData.mainText.length,
            aboutLength: extractedData.aboutText.length,
            headings: extractedData.headings.length
        });

        // Step 3: Use Gemini AI to analyze and extract brand guidelines
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

        const prompt = `Analyze the following website content and extract brand guideline information. Return ONLY a valid JSON object (no markdown formatting, no code blocks) with this exact structure:

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
- About Section: ${extractedData.aboutText}
- Key Headings: ${extractedData.headings.join(', ')}

Analyze this content and extract brand identity, values, tone of voice, and create basic brand guidelines. Be specific and actionable. Return pure JSON only.`;

        const result = await model.generateContent(prompt);
        const aiResponse = result.response.text();

        console.log('AI Response:', aiResponse);

        // Clean and parse JSON response
        let brandGuideline;
        try {
            // Remove markdown code blocks if present
            let cleanedResponse = aiResponse.trim();
            if (cleanedResponse.startsWith('```')) {
                cleanedResponse = cleanedResponse.replace(/```json?\n?/g, '').replace(/```\n?$/g, '');
            }

            brandGuideline = JSON.parse(cleanedResponse);
        } catch (parseError) {
            console.error('JSON parse error:', parseError);
            console.error('AI Response:', aiResponse);
            return res.status(500).json({
                error: 'Failed to parse AI response',
                details: parseError.message,
                rawResponse: aiResponse
            });
        }

        // Add metadata
        const response_data = {
            ...brandGuideline,
            sourceUrl: websiteUrl,
            analyzedAt: new Date().toISOString(),
            method: 'auto_generated',
            confidence: 'medium' // Could be enhanced with more sophisticated analysis
        };

        console.log('Successfully analyzed brand:', response_data.brandName);

        return res.status(200).json({
            success: true,
            data: response_data
        });

    } catch (error) {
        console.error('Error analyzing brand:', error);
        return res.status(500).json({
            error: 'Failed to analyze brand',
            details: error.message
        });
    }
}
