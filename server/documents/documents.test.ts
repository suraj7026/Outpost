import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHTML, renderPDF, csv } from './documents.js';
test('reports escape active content and render actual PDFs plus review evidence',async () => {
  const report = { title: 'Invoice report',sections: [{ heading: 'Summary',body: '<script>alert(1)</script>\nTotal: 25.00 USD' }],sources: [] };
  assert.ok(!renderHTML(report).includes('<script>'));
  const output = await renderPDF(report); assert.ok(output.pdf.length > 1000); assert.ok(output.preview.length > 1000);
  assert.equal(output.checks.visualReview,'required');
  assert.equal(csv([['=1+1','a"b']]),'"\'=1+1","a""b"\r\n');
});
