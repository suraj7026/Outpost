import { chromium } from 'playwright';
import { z } from 'zod';
import { requireThat } from '../core/contracts.js';
export const Report = z.strictObject({ title: z.string().min(1).max(300),sections: z.array(z.strictObject({ heading: z.string().max(300),body: z.string().max(100000) })).min(1).max(100),sources: z.array(z.strictObject({ title: z.string(),url: z.url() })).max(100) });
export type Report = z.infer<typeof Report>;
const escape = (value: string) => value.replace(/[&<>"']/g,char => ({ '&': '&amp;','<': '&lt;','>': '&gt;','"': '&quot;',"'": '&#39;' }[char]!));
export function renderHTML(input: unknown) {
  const report = Report.parse(input);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escape(report.title)}</title><style>body{font:16px/1.6 system-ui;color:#171717;max-width:780px;margin:40px auto;padding:24px}h1{font-size:32px}h2{break-after:avoid}p{white-space:pre-wrap;overflow-wrap:anywhere}section{margin:28px 0}li{overflow-wrap:anywhere}@page{size:A4;margin:20mm}</style><h1>${escape(report.title)}</h1>${report.sections.map(section => `<section><h2>${escape(section.heading)}</h2><p>${escape(section.body)}</p></section>`).join('')}<h2>Sources</h2><ol>${report.sources.map(source => `<li>${escape(source.title)} — ${escape(source.url)}</li>`).join('')}</ol></html>`;
}
export async function renderPDF(report: unknown) {
  const html = renderHTML(report), browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ javaScriptEnabled: false });
    await page.route('**/*',route => route.abort()); await page.setContent(html,{ waitUntil: 'load' });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    requireThat(!overflow,'document_layout_overflow');
    const pdf = await page.pdf({ format: 'A4',printBackground: true,preferCSSPageSize: true });
    requireThat(pdf.subarray(0,5).toString() === '%PDF-','invalid_pdf');
    return { pdf,preview: await page.screenshot({ fullPage: true }),checks: { signature: true,horizontalOverflow: false,visualReview: 'required' } };
  } finally { await browser.close(); }
}
export function csv(rows: string[][]) { return rows.map(row => row.map(value => { const safe = /^[=+@\-\t\r]/.test(value) ? `'${value}` : value; return `"${safe.replaceAll('"','""')}"`; }).join(',')).join('\r\n')+'\r\n'; }
