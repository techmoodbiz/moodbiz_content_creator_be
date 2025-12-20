
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const https = require('https');

// Tạo Agent để bỏ qua lỗi SSL (UNABLE_TO_VERIFY_LEAF_SIGNATURE)
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

module.exports = async function handler(req, res) {
  // --- CORS HANDLING: Chấp nhận tất cả để linh hoạt ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

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

    // 1. Fetch HTML với Headers giả lập Browser cao cấp hơn
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'sec-ch-ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1'
    };

    const response = await fetch(url, {
      method: 'GET',
      agent: url.startsWith('https') ? httpsAgent : null,
      headers: headers,
      redirect: 'follow',
      timeout: 20000 // Tăng lên 20s cho các web chậm
    });

    if (!response.ok) {
      console.error(`❌ Fetch Error: ${response.status}`);
      // Nếu lỗi 403, có thể do website chặn Bot. Trả về thông báo chi tiết cho FE.
      if (response.status === 403) {
        throw new Error("Website này chặn quyền truy cập tự động. Vui lòng copy text thủ công.");
      }
      throw new Error(`Không thể truy cập URL (Status: ${response.status})`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Loại bỏ các thẻ không cần thiết
    $('script, style, noscript, iframe, svg, canvas, video, audio, link, meta').remove();
    $('header, nav, footer, aside, [role="banner"], [role="navigation"], [role="contentinfo"]').remove();

    const title = $('title').text().trim() || $('meta[property="og:title"]').attr('content') || '';

    // Thu thập nội dung text
    let textContent = '';
    $('p, h1, h2, h3, h4, h5, h6, li, article').each((i, el) => {
      const text = $(el).text().trim();
      if (text.length > 20) {
        textContent += text + '\n\n';
      }
    });

    if (!textContent || textContent.length < 100) {
      // Fallback nếu không tìm thấy thẻ p/h1...
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
    console.error('❌ Scrape error:', error.message);
    return res.status(400).json({
      success: false,
      error: error.message
    });
  }
};
