import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';
import { MAX_TEXT } from '../services/chunking.mjs';
import { AppError } from '../lib/errors.mjs';

export async function inspectZip(file) {
  return new Promise((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error)
        return reject(
          new AppError(
            422,
            'INVALID_OFFICE',
            'Die Office-Datei ist beschädigt oder verschlüsselt.',
          ),
        );
      let count = 0;
      let size = 0;
      let settled = false;
      const fail = () => {
        if (!settled) {
          settled = true;
          zip.close();
          reject(
            new AppError(
              422,
              'UNSAFE_ARCHIVE',
              'Die Office-Datei überschreitet die Entpackgrenzen oder ist verschlüsselt.',
            ),
          );
        }
      };
      zip.on('error', fail);
      zip.on('entry', (entry) => {
        count++;
        size += entry.uncompressedSize;
        if (
          count > 5000 ||
          size > 80 * 1024 * 1024 ||
          entry.uncompressedSize > 40 * 1024 * 1024 ||
          entry.uncompressedSize > Math.max(1024 * 1024, entry.compressedSize * 200) ||
          entry.generalPurposeBitFlag & 1
        )
          return fail();
        zip.readEntry();
      });
      zip.on('end', () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      zip.readEntry();
    }),
  );
}
export function extractSqlDocuments(text) {
  const lines = text.split(/\r?\n/);
  const cleanLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      cleanLines.push('');
      continue;
    }
    // Drop MySQL/MariaDB version comments like /*!40101 SET ... */
    if (/^\/\*!\d+[\s\S]*\*\/;?$/i.test(trimmed)) continue;
    // Drop dump control directives
    if (/^SET\s+(SQL_MODE|time_zone|FOREIGN_KEY_CHECKS|UNIQUE_CHECKS|AUTOCOMMIT|NAMES)\s*=/i.test(trimmed)) continue;
    if (/^(START TRANSACTION|COMMIT);?$/i.test(trimmed)) continue;
    // Drop tool export headers
    if (/^--\s+(phpMyAdmin|version|Server version|PHP Version|Host:|Generation Time:)/i.test(trimmed)) continue;
    cleanLines.push(line);
  }
  const cleanedText = cleanLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  // Match table blocks: CREATE TABLE [IF NOT EXISTS] `?name`?
  const tableRegex = /(?:--\s*(?:Tabellenstruktur|Table structure|Struktur|Daten|Data)[^\n]*\n+)?CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([a-zA-Z0-9_]+)`?/gi;
  const docs = [];
  const tableMatches = [];
  let match;

  while ((match = tableRegex.exec(cleanedText)) !== null) {
    tableMatches.push({ index: match.index, tableName: match[1] });
  }

  if (tableMatches.length > 0) {
    if (tableMatches[0].index > 0) {
      const preamble = cleanedText.slice(0, tableMatches[0].index).trim();
      // Only keep preamble if it contains actual SQL statements, not just comment lines
      if (preamble.length > 20 && !/^(?:--[^\n]*\n*)+$/.test(preamble)) {
        docs.push({ text: preamble, location: 'Datenbank-Struktur' });
      }
    }
    for (let i = 0; i < tableMatches.length; i++) {
      const start = tableMatches[i].index;
      const end = i + 1 < tableMatches.length ? tableMatches[i + 1].index : cleanedText.length;
      const tableContent = cleanedText.slice(start, end).trim();
      if (tableContent) {
        docs.push({
          text: tableContent,
          location: `Tabelle: ${tableMatches[i].tableName}`,
        });
      }
    }
  } else {
    docs.push({ text: cleanedText || text, location: 'SQL-Skript' });
  }

  return docs.length > 0 ? docs : [{ text: cleanedText || text, location: 'SQL-Skript' }];
}

export async function extractFile(file, filename) {
  const ext = path.extname(filename).toLowerCase();
  const bytes = await fs.readFile(file);
  let documents = [];
  if (['.docx', '.xlsx'].includes(ext)) {
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b)
      throw new AppError(
        422,
        'INVALID_OFFICE',
        'Die Datei entspricht nicht dem angegebenen Office-Format.',
      );
    await inspectZip(file);
  }
  if (ext === '.pdf') {
    if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-')))
      throw new AppError(422, 'INVALID_PDF', 'Keine gültige PDF-Datei.');
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      standardFontDataUrl: fileURLToPath(
        new URL('./standard_fonts/', import.meta.resolve('pdfjs-dist/package.json')),
      ).replace(/\\/g, '/').replace(/\/?$/, '/'),
    });
    try {
      const pdf = await loadingTask.promise;
      if (pdf.numPages > 300)
        throw new AppError(422, 'TOO_MANY_PAGES', 'PDFs dürfen höchstens 300 Seiten enthalten.');
      for (let page = 1; page <= pdf.numPages; page++) {
        const p = await pdf.getPage(page);
        const content = await p.getTextContent();
        documents.push({
          text: content.items.map((item) => (item.str || '') + (item.hasEOL ? '\n' : ' ')).join(''),
          location: `Seite ${page}`,
        });
        p.cleanup();
        if (documents.reduce((n, d) => n + d.text.length, 0) > MAX_TEXT)
          throw new AppError(422, 'DOCUMENT_TOO_LARGE', 'Die PDF enthält zu viel Text.');
      }
    } finally {
      await loadingTask.destroy();
    }
  } else if (ext === '.docx') {
    const mammoth = await import('mammoth');
    documents = [
      {
        text: (await mammoth.default.extractRawText({ buffer: bytes })).value,
        location: 'Dokument',
      },
    ];
  } else if (ext === '.xlsx') {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    let total = 0;
    for (const sheet of workbook.worksheets) {
      if (sheet.rowCount > 50000 || sheet.columnCount > 500)
        throw new AppError(
          422,
          'SHEET_TOO_LARGE',
          'Die Tabelle enthält zu viele Zeilen oder Spalten.',
        );
      const lines = [];
      sheet.eachRow((row, number) => {
        const cells = [];
        row.eachCell({ includeEmpty: true }, (cell) => {
          const v = cell.value;
          const value =
            v && typeof v === 'object' && ('formula' in v || 'sharedFormula' in v)
              ? String(v.result ?? '[Formel ohne gespeichertes Ergebnis]')
              : cell.text;
          cells.push(value.replace(/[\n\r\t]/g, ' '));
        });
        const line = `Zeile ${number}: ${cells.join(' | ')}`;
        total += line.length;
        if (total > MAX_TEXT)
          throw new AppError(422, 'DOCUMENT_TOO_LARGE', 'Die Tabelle enthält zu viel Text.');
        lines.push(line);
      });
      documents.push({ text: lines.join('\n'), location: `Tabellenblatt: ${sheet.name}` });
    }
  } else if (['.csv', '.txt', '.md', '.sql', '.json'].includes(ext)) {
    let text;
    try {
      if (bytes[0] === 0xff && bytes[1] === 0xfe)
        text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
      else if (bytes[0] === 0xfe && bytes[1] === 0xff)
        text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
      else text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new AppError(
        422,
        'TEXT_ENCODING',
        'Bitte die Textdatei als UTF-8 oder UTF-16 mit BOM speichern.',
      );
    }
    if (text.includes('\0'))
      throw new AppError(422, 'BINARY_TEXT', 'Die Datei enthält Binärdaten.');
    if (ext === '.csv') {
      const { parse } = await import('csv-parse/sync');
      const first = text.split(/\r?\n/)[0] || '';
      const delimiter = first.includes(';') ? ';' : first.includes('\t') ? '\t' : ',';
      const rows = parse(text, {
        bom: true,
        delimiter,
        relax_column_count: true,
        skip_empty_lines: true,
        max_record_size: 100000,
      });
      if (rows.length > 50000)
        throw new AppError(
          422,
          'SHEET_TOO_LARGE',
          'CSV-Dateien dürfen höchstens 50.000 Zeilen enthalten.',
        );
      text = rows.map((row, i) => `Zeile ${i + 1}: ${row.join(' | ')}`).join('\n');
      documents = [{ text, location: 'CSV-Tabelle' }];
    } else if (ext === '.sql') {
      documents = extractSqlDocuments(text);
    } else if (ext === '.json') {
      try {
        const parsed = JSON.parse(text);
        text = JSON.stringify(parsed, null, 2);
      } catch {}
      documents = [{ text, location: 'JSON-Dokument' }];
    } else {
      documents = [{ text, location: ext === '.md' ? 'Markdown' : 'Text' }];
    }
  } else throw new AppError(415, 'FILE_TYPE', 'Dieses Dateiformat wird nicht unterstützt.');
  if (documents.reduce((n, d) => n + d.text.length, 0) > MAX_TEXT)
    throw new AppError(
      422,
      'DOCUMENT_TOO_LARGE',
      'Die Datei enthält zu viel Text. Bitte aufteilen.',
    );
  return documents;
}
if (process.send)
  process.once('message', async ({ file, filename }) => {
    try {
      process.send({ documents: await extractFile(file, filename) }, () => process.exit(0));
    } catch (error) {
      process.send(
        {
          error:
            error instanceof AppError
              ? error.message
              : 'Die Datei konnte nicht gelesen werden. Format, Verschlüsselung und Beschädigung prüfen.',
          code: error.code || 'EXTRACTION_FAILED',
        },
        () => process.exit(1),
      );
    }
  });
