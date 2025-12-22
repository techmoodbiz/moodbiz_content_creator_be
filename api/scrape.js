
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const https = require('https');

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

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
    const { url } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL is required' });
    }

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    };

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

    $('script, style, noscript, iframe, svg, canvas, video, audio, link, meta').remove();
    $('header, nav, footer, aside, [role="banner"], [role="navigation"], [role="contentinfo"]').remove();

    const title = $('title').text().trim() || $('meta[property="og:title"]').attr('content') || '';
    
    let textContent = '';
    $('p, h1, h2, h3, h4, h5, h6, li, article').each((i, el) => {
      const text = $(el).text().trim();
      if (text.length > 20) {
        textContent += text + '\n\n';
      }
    });

    if (!textContent || textContent.length < 100) {
       textContent = $('body').text().substring(0, 5000);
    }

    return res.status(200).json({
      success: true,
      url: url,
      title: title,
      content: textContent,
      text: textContent
    });

  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message
    });
  }
};
