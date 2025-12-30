import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import https from 'https';

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

export default async function handler(req, res) {
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
    const { url } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL is required' });
    }

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    };

    // 1. Fetch HTML
    const response = await fetch(url, {
      method: 'GET',
      agent: url.startsWith('https') ? httpsAgent : null,
      headers: headers,
      redirect: 'follow',
      timeout: 20000
    });

    if (!response.ok) {
      if (response.status === 403) {
         throw new Error("Website này chặn quyền truy cập tự động. Vui lòng copy text thủ công.");
      }
      throw new Error(`Không thể truy cập URL (Status: ${response.status})`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // 2. Basic Cleanup
    $('script, style, noscript, iframe, svg, canvas, video, audio, link, meta').remove();
    $('header, nav, footer, aside, [role="banner"], [role="navigation"], [role="contentinfo"]').remove();

    const title = $('title').text().trim() || $('meta[property="og:title"]').attr('content') || '';
    
    let rawText = '';
    $('body').find('p, h1, h2, h3, h4, h5, h6, li, article, div').each((i, el) => {
       const text = $(el).text().trim().replace(/\s+/g, ' ');
       if (text.length > 0) rawText += text + "\n";
    });

    if (rawText.length < 100) {
        rawText = $('body').text().replace(/\s+/g, ' ').trim();
    }

    let finalContent = rawText;

    // 3. INTELLIGENT CLEANING WITH GEMINI 3.0 FLASH
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey && rawText.length > 200) {
        try {
            const { GoogleGenAI } = await import("@google/genai/node");
            const ai = new GoogleGenAI({ apiKey: apiKey });
            
            const prompt = `
You are a Web Scraper & Content Cleaner Agent.
Your task is to extract the **CORE CONTENT** from the noisy raw text below for an Audit System.

RAW TEXT FROM URL (${url}):
"""
${rawText.substring(0, 100000)}
"""

RULES:
1. **REMOVE NOISE**: Delete navigation menus, footer links ("Contact Us", "Privacy Policy", "Terms"), cookie warnings, "Read more" buttons, ads, and sidebars.
2. **PRESERVE MEANING**: Do not summarize or rewrite paragraphs. Keep the original sentences exactly as they are (important for auditing spelling/grammar). Just remove the surrounding garbage.
3. **FORMAT**: Output clean **Markdown** (headers #, paragraphs, lists -).

OUTPUT MARKDOWN ONLY:
`;
            const geminiRes = await ai.models.generateContent({
                model: 'gemini-3-flash-preview',
                contents: prompt
            });

            if (geminiRes.text && geminiRes.text.length > 50) {
                finalContent = geminiRes.text;
            }
        } catch (aiError) {
            console.error("Gemini Scrape Cleaning Error:", aiError.message);
        }
    }

    return res.status(200).json({
      success: true,
      url: url,
      title: title,
      content: finalContent,
      text: finalContent
    });

  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message
    });
  }
}