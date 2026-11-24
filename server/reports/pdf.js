'use strict';
const fs = require('fs');
const path = require('path');

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = [
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  try {
    for (const d of fs.readdirSync('/opt/pw-browsers')) {
      if (d.startsWith('chromium-')) candidates.push(path.join('/opt/pw-browsers', d, 'chrome-linux64', 'chrome'));
    }
  } catch { /* ignore */ }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

let browserPromise = null;
async function browser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    if (b && b.connected) return b;
  }
  const exe = findChrome();
  if (!exe) throw new Error('لم يتم العثور على متصفح Chrome/Chromium لإنشاء ملفات PDF. ثبّت chromium أو حدد CHROME_PATH');
  const puppeteer = require('puppeteer-core');
  browserPromise = puppeteer.launch({
    executablePath: exe, headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  });
  return browserPromise;
}

// تحويل HTML عربي إلى PDF عبر المتصفح (يحافظ على تشكيل الحروف العربية واتجاه RTL)
async function htmlToPdf(html) {
  const b = await browser();
  const page = await b.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load', timeout: 60000 });
    await page.evaluate(() => document.fonts.ready);
    const buf = await page.pdf({
      format: 'A4', printBackground: true, margin: { top: '10mm', bottom: '12mm', left: '8mm', right: '8mm' },
      displayHeaderFooter: true, headerTemplate: '<span></span>',
      footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#777"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    });
    return Buffer.from(buf);
  } finally {
    await page.close().catch(() => {});
  }
}

async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    browserPromise = null;
    if (b) await b.close().catch(() => {});
  }
}

module.exports = { htmlToPdf, closeBrowser, findChrome };
