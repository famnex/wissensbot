import fs from 'node:fs';
import path from 'node:path';
import { embeddingProfile, vectorToBuffer } from './gemini.mjs';
import { crawl } from './crawler.mjs';
import { chunksFromDocuments } from './chunking.mjs';
import { extractInProcess } from './extraction.mjs';
import { AppError } from '../lib/errors.mjs';

export function parseJsonResponse(text) {
  if (!text || typeof text !== 'string') return null;
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {}
    }
    return null;
  }
}

export async function aiAnalyzeAndStructureChunks({
  gemini,
  chunks,
  sourceTitle,
  signal,
  touch = () => {},
}) {
  if (!gemini || !chunks || chunks.length === 0) return;
  if (typeof gemini.generateContent !== 'function') return;
  try {
    gemini.key();
  } catch {
    return; // Gemini not configured, keep heuristic titles
  }

  const batchSize = 6;
  for (let i = 0; i < chunks.length; i += batchSize) {
    signal?.throwIfAborted();
    touch(
      25 + Math.floor((i / chunks.length) * 25),
      `KI strukturiert Wissen · ${i + 1}/${chunks.length} Abschnitte`,
    );

    const batch = chunks.slice(i, i + batchSize);
    const prompt = `Analysiere die folgenden Abschnitte der Wissensquelle "${sourceTitle}".
Aufgaben pro Abschnitt:
1. "title": Prägnanter, aussagekräftiger Fachtitel (max. 70 Zeichen), der das konkrete Thema benennt (z.B. "Benutzertabelle: Struktur & Rechte", "Passwortregeln"). Vermeide "Ohne Titel" oder "Abschnitt X".
2. "location": Sinnvoller Bezug oder Fundstelle (z.B. "Tabelle users", "Notfallkontakt").
3. "cleanText": Falls der Quelltext aus rohen SQL-Dumps, Steuer-Tags (z.B. /*!40101 ...*/), Boilerplate oder schwer lesbaren Daten besteht, erstelle hier eine strukturierte, lesbare Wissensfassung für das RAG-System. Falls der Quelltext bereits lesbar ist, null setzen.

Abschnitte:
${batch
  .map(
    (c, idx) => `--- ABSCHNITT ${idx + 1} (Location: ${c.location || 'Text'}) ---
${c.text.slice(0, 1800)}`,
  )
  .join('\n\n')}

Antworte ausschließlich mit einem JSON-Array:
[
  { "index": 1, "title": "Titel", "location": "Location", "cleanText": null }
]`;

    try {
      const responseText = await gemini.generateContent({
        prompt,
        systemInstruction:
          'Du bist Wissensanalyst in einem KI-RAG-System. Du analysierst Daten und erstellst saubere, strukturierte Wissensbausteine.',
        signal,
      });

      if (responseText) {
        const parsed = parseJsonResponse(responseText);
        if (Array.isArray(parsed)) {
          for (let j = 0; j < batch.length; j++) {
            const item = parsed.find((p) => p.index === j + 1) || parsed[j];
            if (item) {
              if (item.title && typeof item.title === 'string' && item.title.trim()) {
                batch[j].title = item.title.trim().slice(0, 100);
              }
              if (item.location && typeof item.location === 'string' && item.location.trim()) {
                batch[j].location = item.location.trim().slice(0, 100);
              }
              if (
                item.cleanText &&
                typeof item.cleanText === 'string' &&
                item.cleanText.trim().length > 20
              ) {
                batch[j].text = item.cleanText.trim();
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn('AI chunk analysis skipped for batch:', err.message);
    }
  }
}

export async function aiExtractKnowledgeChunks({
  gemini,
  documents,
  sourceTitle,
  signal,
  touch = () => {},
}) {
  if (!gemini || !documents || documents.length === 0) return null;
  if (typeof gemini.generateContent !== 'function') return null;
  try {
    gemini.key();
  } catch {
    return null; // Gemini not configured, use heuristic chunking
  }

  const allChunks = [];
  const WINDOW_SIZE = 30000;

  for (let d = 0; d < documents.length; d++) {
    signal?.throwIfAborted();
    const doc = documents[d];
    const fullText = (doc.text || '').trim();
    if (!fullText) continue;

    const windows = [];
    if (fullText.length <= WINDOW_SIZE) {
      windows.push(fullText);
    } else {
      let start = 0;
      while (start < fullText.length) {
        let end = Math.min(start + WINDOW_SIZE, fullText.length);
        if (end < fullText.length) {
          const boundary = Math.max(
            fullText.lastIndexOf('\n\n', end),
            fullText.lastIndexOf(';\n', end),
            fullText.lastIndexOf('. ', end),
            fullText.lastIndexOf('\n', end),
          );
          if (boundary > start + WINDOW_SIZE * 0.6) end = boundary + 1;
        }
        const slice = fullText.slice(start, end).trim();
        if (slice) windows.push(slice);
        if (end === fullText.length) break;
        start = end;
      }
    }

    for (let w = 0; w < windows.length; w++) {
      signal?.throwIfAborted();
      touch(
        20 + Math.floor(((d * windows.length + w) / (documents.length * windows.length)) * 30),
        `KI identifiziert Wissensbausteine (${w + 1}/${windows.length}) …`,
      );

      const prompt = `Analysiere den folgenden Quelltext aus der Wissensquelle "${sourceTitle}" (Fundstelle: ${doc.location || 'Dokument'}).
Finde und extrahiere alle eigenständigen, inhaltlich zusammenhängenden WISSENSBAUSTEINE (z. B. einzelne FAQs, Regeln, Bestimmungen, Richtlinien, Tabelleninhalte oder Themen).

WICHTIGE ANWEISUNGEN FÜR JEDEN GEFUNDENEN WISSENSBAUSTEIN:
1. "title": Prägnanter, aussagekräftiger Fachtitel (max. 80 Zeichen). Benenne das konkrete Thema oder die Frage (z. B. "Aufsicht bei Klausuren", "Beurlaubung von Schülern", "Nachschriften"). Niemals "Ohne Titel", "Abschnitt X" oder HTML-Fragmente.
2. "location": Sinnvolle Fundstelle oder Oberkategorie (z. B. "Klausuren & Arbeiten", "Schulordnung", "FAQ").
3. "text": Der vollständige, in sich geschlossene Inhalt:
   - Wandle HTML-Tags (z. B. <ul>, <li>, <p>, <br>) in sauberen, gut lesbaren Text/Aufzählungen um.
   - Entferne SQL-Befehle, Dump-Header, Spalten-IDs (z. B. (40, 11, 1, ...)).
   - Behalte alle fachlichen Details, Fakten, Regeln und Erklärungen vollständig bei.

Quelltext:
${windows[w]}

Antworte ausschließlich mit einem validen JSON-Array aus Objekten:
[
  {
    "title": "Aussagekräftiger Fachtitel",
    "location": "Thema oder Fundstelle",
    "text": "Vollständiger, sauber formulierter Wissenstext..."
  }
]`;

      try {
        const responseText = await gemini.generateContent({
          prompt,
          systemInstruction:
            'Du bist Wissensanalyst in einem KI-RAG-System. Du identifizierst, extrahierst und strukturierst eigenständige Wissensbausteine ohne HTML- oder SQL-Ballast.',
          signal,
          temperature: 0.1,
        });

        if (responseText) {
          const parsed = parseJsonResponse(responseText);
          if (Array.isArray(parsed) && parsed.length > 0) {
            for (const item of parsed) {
              if (
                item &&
                item.text &&
                typeof item.text === 'string' &&
                item.text.trim().length > 15
              ) {
                allChunks.push({
                  title:
                    item.title && typeof item.title === 'string' && item.title.trim()
                      ? item.title.trim().slice(0, 150)
                      : (doc.location || 'Wissensbaustein'),
                  location:
                    item.location && typeof item.location === 'string' && item.location.trim()
                      ? item.location.trim().slice(0, 150)
                      : (doc.location || 'Wissensbasis'),
                  url: doc.url || null,
                  text: item.text.trim(),
                });
              }
            }
          }
        }
      } catch (err) {
        console.warn('AI knowledge extraction failed for window:', err.message);
      }
    }
  }

  return allChunks.length > 0 ? allChunks : null;
}

export async function processClaimedJob({
  db,
  config,
  gemini,
  job,
  owner,
  signal,
  touch = () => {},
}) {
  const payload = JSON.parse(job.payload);
  const source = db.prepare('SELECT * FROM sources WHERE id=?').get(job.source_id);
  if (!source) throw new AppError(409, 'SOURCE_REMOVED', 'Die Quelle wurde entfernt.');
  // Check configuration before expensive extraction/crawling.
  gemini.key();
  const model = gemini.embeddingModel();
  const profile = embeddingProfile(model);
  let documents = source.documents_json ? JSON.parse(source.documents_json) : null;
  let warning = source.warning || null;
  if (!documents) {
    if (source.type === 'url') {
      ({ documents, warning } = await crawl(source.reference, {
        maxPages: config.crawlMaxPages,
        progress: touch,
        signal,
      }));
    } else if (source.type === 'file') {
      touch(10, 'Datei wird gelesen');
      const file = path.resolve(config.uploadDir, payload.filename || '');
      if (
        path.dirname(file) !== config.uploadDir ||
        !/^[a-f0-9-]+\.upload$/.test(path.basename(file))
      )
        throw new AppError(
          422,
          'UPLOAD_MISSING',
          'Die Originaldatei fehlt. Bitte erneut hochladen.',
        );
      documents = await extractInProcess(file, source.reference, signal);
    } else throw new AppError(422, 'EMPTY_DOCUMENT', 'Die Quelle enthält keinen Text.');
  }
  signal?.throwIfAborted();
  touch(20, 'KI identifiziert Wissensbausteine …');
  let chunks = await aiExtractKnowledgeChunks({
    gemini,
    documents,
    sourceTitle: source.title,
    signal,
    touch,
  });

  // Fallback to heuristic chunking if AI extraction is unavailable
  if (!chunks || chunks.length === 0) {
    chunks = chunksFromDocuments(documents);
    if (chunks.length > 0) {
      await aiAnalyzeAndStructureChunks({
        gemini,
        chunks,
        sourceTitle: source.title,
        signal,
        touch,
      });
    }
  }

  db.prepare('UPDATE sources SET documents_json=?,warning=?,updated_at=? WHERE id=?').run(
    JSON.stringify(documents),
    warning,
    Date.now(),
    source.id,
  );
  const vectors = [];
  for (let i = 0; i < chunks.length; i += 24) {
    signal?.throwIfAborted();
    touch(
      55 + Math.floor((i / chunks.length) * 40),
      `Wissen indexieren · ${i}/${chunks.length} Abschnitte`,
    );
    vectors.push(
      ...(await gemini.embed(
        chunks.slice(i, i + 24).map((c) => ({ text: c.text, title: source.title })),
        { model, signal },
      )),
    );
  }
  signal?.throwIfAborted();
  db.transaction(() => {
    const owned = db
      .prepare("SELECT 1 FROM jobs WHERE id=? AND lease_owner=? AND status='processing'")
      .get(job.id, owner);
    if (!owned || gemini.embeddingModel() !== model)
      throw new AppError(409, 'JOB_OBSOLETE', 'Die Indexierung wurde ersetzt.');
    db.prepare('DELETE FROM chunks WHERE source_id=?').run(source.id);
    const insert = db.prepare(
      'INSERT INTO chunks(source_id,ordinal,text,location,url,vector,profile,title) VALUES(?,?,?,?,?,?,?,?)',
    );
    chunks.forEach((c, i) =>
      insert.run(
        source.id,
        i,
        c.text,
        c.location,
        c.url,
        vectorToBuffer(vectors[i]),
        profile,
        c.title || null,
      ),
    );
    db.prepare(
      "UPDATE sources SET status='ready',chunk_count=?,error=NULL,warning=?,updated_at=? WHERE id=?",
    ).run(chunks.length, warning, Date.now(), source.id);
    db.prepare(
      "UPDATE jobs SET status='done',progress=100,stage='Abgeschlossen',payload='{}',error=NULL,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?",
    ).run(Date.now(), job.id);
  }).immediate();
  if (payload.filename && /^[a-f0-9-]+\.upload$/.test(payload.filename))
    fs.rmSync(path.join(config.uploadDir, payload.filename), { force: true });
}
