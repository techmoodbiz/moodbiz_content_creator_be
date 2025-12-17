
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const https = require('https');

// Tạo Agent để bỏ qua lỗi SSL (UNABLE_TO_VERIFY_LEAF_SIGNATURE)
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

module.exports = async function handler(req, res) {
  // --- CORS HANDLING ---
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

    // 1. Fetch HTML với Headers giả lập Browser đầy đủ hơn
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
      'Referer': 'https://www.google.com/',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache'
    };

    const response = await fetch(url, {
      method: 'GET',
      agent: url.startsWith('https') ? httpsAgent : null,
      headers: headers,
      redirect: 'follow',
      timeout: 15000 // 15s timeout
    });

    if (!response.ok) {
      // Đọc lỗi text nếu có
      const errText = await response.text().catch(() => '');
      console.error(`❌ Fetch Error: ${response.status} - ${errText.substring(0, 100)}`);
      throw new Error(`Failed to fetch URL. Status: ${response.status}`);
    }

    const html = await response.text();

    // 2. Parse HTML & Extract Text
    const $ = cheerio.load(html);

    // --- CLEANUP STRATEGY (An toàn hơn) ---
    // Xóa các thẻ rác cơ bản
    $('script, style, noscript, iframe, svg, canvas, video, audio, link, meta').remove();
    
    // Xóa các phần cấu trúc trang không phải nội dung (Header, Nav, Footer, Sidebar)
    $('header, nav, footer, aside, [role="banner"], [role="navigation"], [role="contentinfo"]').remove();
    
    // Xóa các element dựa trên class/id phổ biến nhưng KHÔNG dùng wildcard rộng (*=) để tránh xóa nhầm
    // Thay vào đó xóa chính xác hoặc bắt đầu bằng
    $('.menu, #menu, .nav, .navigation, #navigation, .footer, #footer, .sidebar, #sidebar').remove();
    $('.cookie-banner, .popup, .modal, .advertisement, .ads, .social-share, .comments, .related-posts').remove();

    // Lấy tiêu đề & mô tả
    const title = $('title').text().trim() || $('meta[property="og:title"]').attr('content') || '';
    const description = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';

    // --- CONTENT EXTRACTION STRATEGY ---
    // Ưu tiên tìm vùng nội dung chính xác
    const contentSelectors = [
      'article',                 // Chuẩn HTML5
      '.entry-content',          // WordPress chuẩn
      '.post-content',           // WordPress biến thể
      '.content-body',           // Phổ biến
      '.prose',                  // Tailwind typography
      '[role="main"]',           // ARIA
      '#content',                // Generic ID
      'main',                    // HTML5 Main
    ];

    let contentEl = null;

    // Thử từng selector, lấy cái đầu tiên có chứa text đáng kể
    for (const selector of contentSelectors) {
      const el = $(selector);
      if (el.length > 0 && el.text().trim().length > 200) {
         contentEl = el;
         console.log(`✅ Found content using selector: ${selector}`);
         break;
      }
    }

    // Fallback: Nếu không tìm thấy vùng content đặc thù, lấy body (đã được dọn dẹp ở trên)
    if (!contentEl) {
       console.log('⚠️ No specific content container found, falling back to body');
       contentEl = $('body');
    }

    // Clean text: chuyển nhiều khoảng trắng/xuống dòng thành 1 khoảng trắng
    let textContent = contentEl.text()
      .replace(/[\t\n\r]+/g, ' ') // Chuyển xuống dòng thành space
      .replace(/\s+/g, ' ')       // Xóa space thừa
      .trim();

    // Final Validation
    if (!textContent || textContent.length < 50) {
       console.error('❌ Content too short after scraping');
       return res.status(400).json({ error: 'Không tìm thấy nội dung bài viết trên link này (Content too short).' });
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
    // Trả về 400 nếu lỗi là do fetch fail (client gửi link lỗi/chặn), 500 nếu lỗi code
    const status = error.message.includes('Failed to fetch') ? 400 : 500;
    return res.status(status).json({
      success: false,
      error: error.message || 'Failed to scrape website'
    });
  }
};
