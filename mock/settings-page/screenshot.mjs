import { chromium, webkit } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const out = resolve(root, 'visual-review');
mkdirSync(out, { recursive: true });
const pageUrl = `file://${resolve(root, 'index.html')}`;

const engine = process.env.OUTPOST_TEST_BROWSER === 'webkit' ? webkit : chromium;
const browser = await engine.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 900 }, colorScheme: 'dark' });
await page.goto(pageUrl);
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(700);

await page.screenshot({ path: `${out}/dark-default.png`, fullPage: true });

await page.getByRole('switch', { name: 'Frosted glass' }).click();
await page.waitForTimeout(450);
await page.screenshot({ path: `${out}/dark-frost-off.png`, fullPage: true });
await page.getByRole('switch', { name: 'Frosted glass' }).click();

await page.getByRole('radio', { name: 'Light', exact: true }).click();
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/light-default.png`, fullPage: true });

await page.setViewportSize({ width: 480, height: 900 });
await page.waitForTimeout(450);
await page.screenshot({ path: `${out}/light-narrow.png`, fullPage: true });

await browser.close();
console.log(`PASS: screenshots written to ${out}`);
