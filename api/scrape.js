
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const https = require('https');

// Tạo Agent để bỏ qua lỗi SSL (UNABLE_TO_VERIFY_LEAF_SIGNATURE)
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

module.exports = async function handler(req, res) {
  // --- CORS HANDLING (Giống api/audit.js) ---
  const allowedOrigin = req.headers.origin;
  const whitelist = [
    'https://moodbiz---rbac.web.app',
    'http://localhost:5000',
    'http://localhost:3000',
    'http://127.0.0.1:5500',
    'https://brandchecker.moodbiz.agency'
  ];

  if (whitelist.includes(allowedOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

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

    console.log('🕷️ Scraping URL:', url);

    // 1. Fetch HTML
    // Giả lập User-Agent để tránh bị chặn bởi một số firewall đơn giản
    const response = await fetch(url, {
      method: 'GET',
      agent: url.startsWith('https') ? httpsAgent : null,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      },
      timeout: 15000 // 15s timeout
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch URL. Status: ${response.status} ${response.statusText}`);
    }

    const html = await response.text();

    // 2. Parse HTML & Extract Text
    const $ = cheerio.load(html);

    // Loại bỏ các phần tử không cần thiết (Script, Style, Nav, Footer, Ads...)
    $('script').remove();
    $('style').remove();
    $('noscript').remove();
    $('iframe').remove();
    $('svg').remove();
    $('header').remove(); // Thường chứa menu
    $('nav').remove();    // Thường chứa menu
    $('footer').remove(); // Thường chứa link footer
    $('[class*="menu"]').remove();
    $('[class*="nav"]').remove();
    $('[class*="footer"]').remove();
    $('[class*="cookie"]').remove();
    $('[class*="popup"]').remove();
    $('[id*="menu"]').remove();

    // Lấy tiêu đề
    const title = $('title').text().trim() || '';
    const description = $('meta[name="description"]').attr('content') || '';

    // Lấy nội dung text chính
    // Ưu tiên thẻ article hoặc main nếu có
    let contentEl = $('article');
    if (contentEl.length === 0) contentEl = $('main');
    if (contentEl.length === 0) contentEl = $('body');

    // Clean text: chuyển nhiều khoảng trắng/xuống dòng thành 1 khoảng trắng
    let textContent = contentEl.text()
      .replace(/\s+/g, ' ')
      .trim();

    // Giới hạn độ dài để tránh quá tải token AI (nếu cần)
    // textContent = textContent.slice(0, 15000); 

    if (!textContent) {
       return res.status(400).json({ error: 'No content found on website' });
    }

    console.log('✅ Scrape success. Text length:', textContent.length);

    // Trả về kết quả
    return res.status(200).json({
      success: true,
      url: url,
      title: title,
      description: description,
      content: textContent,
      text: textContent // fallback support
    });

  } catch (error) {
    console.error('❌ Scrape error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to scrape website'
    });
  }
};
