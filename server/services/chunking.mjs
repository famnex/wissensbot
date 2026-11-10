import { AppError } from '../lib/errors.mjs';
export const MAX_TEXT = 2_000_000;

export function deriveChunkTitle(text, location = '', ordinal = 0) {
  const fallback = location ? `${location} – Abschnitt ${ordinal + 1}` : `Abschnitt ${ordinal + 1}`;
  if (!text || typeof text !== 'string') return fallback;

  // Filter out comments/directives that are pure dump noise
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(
      (l) =>
        l &&
        !/^\/\*!\d+/i.test(l) &&
        !/^SET\s+[A-Z_]+\s*=/i.test(l) &&
        !/^(START TRANSACTION|COMMIT);?$/i.test(l),
    );

  if (!lines.length) return fallback;

  const fullText = lines.slice(0, 12).join('\n');

  // 1. SQL-specific pattern matching
  const sqlTableMatch = fullText.match(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([a-zA-Z0-9_]+)`?/i,
  );
  if (sqlTableMatch) {
    return `Tabelle ${sqlTableMatch[1]}: Struktur & Schema`;
  }

  const sqlCommentStructure = fullText.match(
    /--\s*Tabellenstruktur\s+für\s+Tabelle\s+`?([a-zA-Z0-9_]+)`?/i,
  );
  if (sqlCommentStructure) {
    return `Tabelle ${sqlCommentStructure[1]}: Tabellenstruktur`;
  }

  const sqlCommentData = fullText.match(
    /--\s*Daten\s+für\s+Tabelle\s+`?([a-zA-Z0-9_]+)`?/i,
  );
  if (sqlCommentData) {
    return `Tabelle ${sqlCommentData[1]}: Datensätze`;
  }

  const sqlInsertMatch = fullText.match(/INSERT\s+INTO\s+`?([a-zA-Z0-9_]+)`?/i);
  if (sqlInsertMatch) {
    return `Tabelle ${sqlInsertMatch[1]}: Datensätze & Inhalte`;
  }

  const sqlAlterMatch = fullText.match(/ALTER\s+TABLE\s+`?([a-zA-Z0-9_]+)`?/i);
  if (sqlAlterMatch) {
    return `Tabelle ${sqlAlterMatch[1]}: Tabellenanpassung`;
  }

  // 2. Markdown Headings (# Heading)
  const firstLine = lines[0];
  const headingMatch = firstLine.match(/^#{1,6}\s+(.+)$/);
  if (headingMatch && headingMatch[1].trim()) {
    return headingMatch[1].trim().slice(0, 100);
  }

  // 3. Meaningful comment lines (-- Comment or // Comment)
  const commentMatch = firstLine.match(/^(?:--|\/\/|\/\*)\s*([A-Za-z0-9ÄÖÜäöüß][^*\n]{3,80})/);
  if (commentMatch && commentMatch[1].trim()) {
    return commentMatch[1].replace(/[*_~`#\-\s]+$/, '').trim().slice(0, 100);
  }

  // 4. Short prominent first lines (e.g. bold or capitalized title lines)
  if (firstLine.length >= 3 && firstLine.length <= 90 && !/[.!?]$/.test(firstLine)) {
    const cleaned = firstLine
      .replace(/^[*_~`#\-\d.)\s]+/, '')
      .replace(/[*_~`#\-\s]+$/, '')
      .trim();
    if (cleaned) return cleaned.slice(0, 100);
  }

  // 5. First sentence extraction
  const sentenceMatch = text.match(/^([^.!?\n]{5,90}[.!?])/);
  if (sentenceMatch && sentenceMatch[1].trim()) {
    const cleaned = sentenceMatch[1]
      .replace(/^[*_~`#\-\d.)\s]+/, '')
      .replace(/[*_~`#\-\s]+$/, '')
      .trim();
    if (cleaned) return cleaned.slice(0, 100);
  }

  // 6. JSON property detection
  const jsonNameMatch = fullText.match(/"(?:name|title|table|topic)":\s*"([^"]{3,60})"/i);
  if (jsonNameMatch) {
    return jsonNameMatch[1].slice(0, 80);
  }

  // 7. Clean truncated line
  if (firstLine.length > 70) {
    const cut = firstLine.slice(0, 70);
    const lastSpace = cut.lastIndexOf(' ');
    const summary = (lastSpace > 30 ? cut.slice(0, lastSpace) : cut).trim();
    return summary + '…';
  }

  return (
    firstLine.slice(0, 100) ||
    (location ? `${location} · #${ordinal + 1}` : `Abschnitt ${ordinal + 1}`)
  );
}

export function chunksFromDocuments(documents, { size = 1800, overlap = 220 } = {}) {
  if (!Number.isInteger(size) || overlap < 0 || overlap >= size / 2)
    throw new Error('Invalid chunk parameters');
  const chunks = [];
  if (documents.reduce((n, d) => n + d.text.length, 0) > MAX_TEXT)
    throw new AppError(
      422,
      'DOCUMENT_TOO_LARGE',
      'Die Quelle enthält zu viel Text. Bitte in kleinere Dateien aufteilen.',
    );
  for (const doc of documents) {
    const text = doc.text
      .replace(/\u0000/g, '')
      .replace(/\/\*!\d+[\s\S]*?\*\/;?/g, '')
      .replace(/SET\s+(?:SQL_MODE|time_zone|FOREIGN_KEY_CHECKS|UNIQUE_CHECKS|AUTOCOMMIT|NAMES)\s*=[^;\n]*;?/gi, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + size, text.length);
      if (end < text.length) {
        const boundary = Math.max(
          text.lastIndexOf('\n', end),
          text.lastIndexOf('. ', end),
          text.lastIndexOf(' ', end),
        );
        if (boundary > start + size * 0.65) end = boundary + 1;
      }
      const chunk = text.slice(start, end).trim();
      if (chunk) {
        const title = deriveChunkTitle(chunk, doc.location, chunks.length);
        chunks.push({ title, text: chunk, location: doc.location || 'Text', url: doc.url || null });
      }
      if (end === text.length) break;
      start = Math.max(start + 1, end - overlap);
    }
  }
  if (!chunks.length)
    throw new AppError(
      422,
      'EMPTY_DOCUMENT',
      'Kein lesbarer Text gefunden. Gescannte PDFs benötigen vorher eine Texterkennung (OCR).',
    );
  if (chunks.length > 1600)
    throw new AppError(
      422,
      'TOO_MANY_CHUNKS',
      'Die Quelle ist zu umfangreich. Bitte in mehrere Quellen aufteilen.',
    );
  return chunks;
}
