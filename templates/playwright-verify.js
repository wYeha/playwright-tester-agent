/**
 * Проверка, что Playwright и Chromium запускаются в проекте.
 * Использование: npm run playwright:verify
 */
const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || '{{BASE_URL}}';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    const response = await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    const status = response ? response.status() : 0;
    const title = await page.title();
    console.log('PLAYWRIGHT_OK');
    console.log(`url=${BASE_URL} status=${status} title=${title}`);
    if (status < 200 || status >= 400) {
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error('PLAYWRIGHT_FAIL:', error.message);
  process.exit(1);
});
