
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const https = require('https');

// Agent để bỏ qua lỗi SSL
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

module.exports = async function handler(req, res) {
  // CORS
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
  }

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    console.log('🕷️ Scraping URL:', url);

    // Headers giả lập trình duyệt thật để tránh bị chặn (400 Bad Request / 403 Forbidden)
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Cache-Control': 'max-age=0'
    };

    const response = await fetch(url, {
      method: 'GET',
      agent: url.startsWith('https') ? httpsAgent : null,
      headers: headers,
      redirect: 'follow',
      timeout: 20000 
    });

    if (!response.ok) {
      throw new Error(`Server returned ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Cleanup: Xóa rác nhưng giữ lại cấu trúc chính
    $('script, style, noscript, iframe, svg, video, audio, link, meta').remove();
    $('header, nav, footer, aside, [role="banner"], [role="navigation"]').remove();
    $('.menu, .nav, .footer, .sidebar, .ads, .popup, .comment, .share').remove();

    // 1. Lấy Meta Data
    const title = $('title').text().trim() || $('meta[property="og:title"]').attr('content') || '';
    const description = $('meta[name="description"]').attr('content') || '';

    // 2. Tìm Content chính
    // Danh sách selector phổ biến cho bài viết/blog
    const selectors = [
      'article', 
      '.entry-content', 
      '.post-content', 
      '.content-body',
      'main', 
      '#content', 
      '.blog-post',
      '.news-detail'
    ];

    let contentEl = null;
    for (const sel of selectors) {
      if ($(sel).length > 0) {
        // Kiểm tra xem vùng này có text đủ dài không
        if ($(sel).text().trim().length > 200) {
          contentEl = $(sel);
          console.log(`✅ Found content via selector: ${sel}`);
          break;
        }
      }
    }

    // Fallback: Nếu không tìm thấy vùng content cụ thể, lấy tất cả thẻ <p> trong body
    let textContent = '';
    if (contentEl) {
      textContent = contentEl.text();
    } else {
      console.log('⚠️ Fallback: Gathering all paragraphs');
      $('body p').each((i, el) => {
        const text = $(el).text().trim();
        if (text.length > 20) textContent += text + '\n\n';
      });
    }

    // Làm sạch text
    textContent = textContent
      .replace(/[\t\r]+/g, ' ')
      .replace(/\n\s*\n/g, '\n\n') // Giữ lại cấu trúc đoạn văn
      .trim();

    if (!textContent || textContent.length < 50) {
       // Cố gắng lấy toàn bộ body text nếu vẫn thất bại
       textContent = $('body').text().replace(/\s+/g, ' ').trim();
       if (textContent.length < 50) {
          return res.status(400).json({ error: 'Không lấy được nội dung (Content too short or protected).' });
       }
    }

    return res.status(200).json({
      success: true,
      url,
      title,
      description,
      content: textContent,
      text: textContent
    });

  } catch (error) {
    console.error(`❌ Scrape Failed: ${error.message}`);
    const status = error.message.includes('400') ? 400 : 500;
    return res.status(status).json({ success: false, error: error.message });
  }
};
