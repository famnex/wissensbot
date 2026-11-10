import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { publicAddress, validateUrl, safeFetch } from '../server/services/safe-fetch.mjs';
import { crawl } from '../server/services/crawler.mjs';
import { extractInProcess } from '../server/services/extraction.mjs';
import { chunksFromDocuments } from '../server/services/chunking.mjs';

test('Crawler rejects private, reserved, mapped and credentialed destinations and external redirects', async () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.2.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '224.0.0.1',
    '2001:db8::1',
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('8.8.8.8'), true);
  for (const url of [
    'file:///etc/passwd',
    'http://localhost',
    'http://127.1',
    'http://user:pass@example.com',
    'https://example.com:444',
    'http://[::1]',
  ])
    assert.throws(() => validateUrl(url));
  let fetches = 0;
  await assert.rejects(
    safeFetch('https://example.com', {
      lookup: async () => [{ address: '10.0.0.1', family: 4 }],
      fetchImpl: async () => {
        fetches++;
      },
    }),
    /privates/,
  );
  assert.equal(fetches, 0);
  await assert.rejects(
    safeFetch('https://example.com', {
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      fetchImpl: async () =>
        new Response('', { status: 302, headers: { location: 'https://evil.example/path' } }),
    }),
    /andere Domains/,
  );
});
test('Crawler visits root and two levels only, follows same-host links and respects robots.txt', async () => {
  const fetched = [];
  const pages = {
    '/robots.txt': 'User-agent: *\nDisallow: /private',
    '/': '<title>Start</title><main>Startwissen <a href="/one">One</a><a href="/private">Private</a><a href="https://external.test/">External</a><a href="https://sub.example.com/">Subdomain</a></main>',
    '/one': '<main>Erste Ebene <a href="/two">Two</a></main>',
    '/two': '<main>Zweite Ebene <a href="/three">Three</a></main>',
  };
  const result = await crawl('https://example.com/', {
    pause: async () => {},
    fetchPage: async (url, options) => {
      fetched.push(url);
      await options.beforeRequest?.(url);
      return {
        url,
        status: 200,
        text: pages[new URL(url).pathname],
        contentType: new URL(url).pathname === '/robots.txt' ? 'text/plain' : 'text/html',
      };
    },
  });
  assert.deepEqual(fetched, [
    'https://example.com/robots.txt',
    'https://example.com/',
    'https://example.com/one',
    'https://example.com/two',
  ]);
  assert.equal(result.documents.length, 3);
  assert.match(result.warning, /robots/);
});
test('Redirect targets are checked before requests and oversized pages are stopped', async () => {
  const fetched = [];
  await assert.rejects(
    safeFetch('https://example.com/', {
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      beforeRequest: async (url) => {
        if (url.endsWith('/private')) throw new Error('robots denied');
      },
      fetchImpl: async (url) => {
        fetched.push(String(url));
        return new Response('', { status: 302, headers: { location: '/private' } });
      },
    }),
    /robots denied/,
  );
  assert.equal(fetched.length, 1);
  await assert.rejects(
    safeFetch('https://example.com/', {
      maxBytes: 10,
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      fetchImpl: async () => new Response('more than ten bytes here'),
    }),
    /Größenlimit/,
  );
});
function pdfFixture(text) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 12 Tf 72 700 Td (${text}) Tj ET`;
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  let file = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(file));
    file += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(file);
  file += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(file);
}
test('TXT, Markdown, CSV, DOCX, XLSX and PDF are parsed in isolated child processes', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wissensraum-formats-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
  );
  zip.file(
    'word/document.xml',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Wissensraum DOCX</w:t></w:r></w:p></w:body></w:document>',
  );
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Wissen');
  sheet.addRow(['Ort', 'Wissensraum XLSX']);
  sheet.getCell('B2').value = { formula: '1+1', result: 2 };
  const formats = {
    txt: Buffer.from('Wissensraum TXT'),
    md: Buffer.from('# Wissensraum MD'),
    csv: Buffer.from('Name;Wert\nWissensraum CSV;"Eine mehrzeilige\nAngabe"'),
    docx: await zip.generateAsync({ type: 'nodebuffer' }),
    xlsx: await workbook.xlsx.writeBuffer(),
    pdf: pdfFixture('Wissensraum PDF'),
  };
  for (const [ext, bytes] of Object.entries(formats)) {
    const filename = `fixture.${ext}`;
    const file = path.join(dir, filename);
    await fs.writeFile(file, bytes);
    const docs = await extractInProcess(file, filename, new AbortController().signal);
    assert.match(
      docs.map((d) => d.text).join('\n'),
      new RegExp(`Wissensraum ${ext.toUpperCase()}`),
    );
    assert.ok(chunksFromDocuments(docs).length >= 1);
  }
  const invalid = path.join(dir, 'bad.pdf');
  await fs.writeFile(invalid, 'not a pdf');
  await assert.rejects(extractInProcess(invalid, 'bad.pdf'), /PDF/);
});
test('Office ZIP expansion limits reject compressed bombs before parsing', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wissensraum-bomb-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const zip = new JSZip();
  zip.file('word/document.xml', 'A'.repeat(2 * 1024 * 1024));
  const file = path.join(dir, 'bomb.docx');
  await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  await assert.rejects(extractInProcess(file, 'bomb.docx'), /Entpackgrenzen/);
});
