import { setTimeout as delay } from 'node:timers/promises';
import { getSetting } from '../db/index.mjs';
import { unseal } from '../lib/secrets.mjs';
import { AppError } from '../lib/errors.mjs';

const API = 'https://generativelanguage.googleapis.com/v1beta/';
export const DIMENSIONS = 768;
export function isChatModel(model) {
  return (
    /^models\/[a-zA-Z0-9._-]+$/.test(model.name || '') &&
    model.supportedGenerationMethods?.includes('generateContent') &&
    !/(embedding|imagen|image|veo|tts|audio|native-audio|live|robotic|computer-use|deep-research|aqa)/i.test(
      model.name,
    )
  );
}
export function embeddingProfile(model) {
  return `${model}:768:${model.includes('embedding-2') ? 'prompt-v1' : 'task-v1'}`;
}
export function normalize(values) {
  if (
    !Array.isArray(values) ||
    values.length !== DIMENSIONS ||
    values.some((v) => !Number.isFinite(v))
  )
    throw new AppError(
      502,
      'INVALID_EMBEDDING',
      'Der Embedding-Dienst hat einen ungültigen Vektor geliefert.',
    );
  const norm = Math.sqrt(values.reduce((sum, x) => sum + x * x, 0));
  if (!norm)
    throw new AppError(
      502,
      'INVALID_EMBEDDING',
      'Der Embedding-Dienst hat einen leeren Vektor geliefert.',
    );
  return values.map((v) => v / norm);
}
export function vectorToBuffer(vector) {
  const b = Buffer.alloc(DIMENSIONS * 4);
  vector.forEach((v, i) => b.writeFloatLE(v, i * 4));
  return b;
}
export class Gemini {
  constructor(db, config, fetchImpl = fetch) {
    this.db = db;
    this.config = config;
    this.fetch = fetchImpl;
  }
  key() {
    const encrypted = getSetting(this.db, 'gemini_key');
    if (!encrypted)
      throw new AppError(
        503,
        'GEMINI_NOT_CONFIGURED',
        'Der Gemini-Zugang wurde noch nicht eingerichtet. Bitte wende dich an einen Administrator.',
      );
    try {
      return unseal(encrypted, this.config.encryptionKey, 'gemini-key');
    } catch {
      throw new AppError(
        503,
        'KEY_UNREADABLE',
        'Der gespeicherte API-Schlüssel kann mit dem konfigurierten Verschlüsselungsschlüssel nicht gelesen werden.',
      );
    }
  }
  embeddingModel() {
    return getSetting(this.db, 'embedding_model', 'models/gemini-embedding-001');
  }
  chatModel() {
    const stored = getSetting(this.db, 'chat_model');
    if (!stored) return 'models/gemini-2.5-flash';
    try {
      const parsed = JSON.parse(stored);
      return parsed?.name || parsed;
    } catch {
      return stored;
    }
  }
  async generateContent({
    prompt,
    systemInstruction,
    model = this.chatModel(),
    signal,
    temperature = 0.2,
  }) {
    if (!model) return null;
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      ...(systemInstruction
        ? { systemInstruction: { parts: [{ text: systemInstruction }] } }
        : {}),
      generationConfig: {
        temperature,
      },
    };
    const result = await this.request(`${model}:generateContent`, { body, signal });
    const part = result.candidates?.[0]?.content?.parts?.find((p) => p.text && !p.thought);
    return part ? part.text.trim() : null;
  }
  async request(endpoint, { body, key, signal, stream = false } = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = await this.fetch(`${API}${endpoint}`, {
          method: body ? 'POST' : 'GET',
          headers: { 'x-goog-api-key': key || this.key(), 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.any([
            AbortSignal.timeout(stream ? 180000 : 45000),
            ...(signal ? [signal] : []),
          ]),
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof AppError) throw error;
        if (attempt < 2) {
          await delay(500 * 2 ** attempt, undefined, { signal });
          continue;
        }
        throw new AppError(
          502,
          'GEMINI_UNREACHABLE',
          'Gemini ist gerade nicht erreichbar. Bitte später erneut versuchen.',
          true,
        );
      }
      if (!response.ok) {
        await response.body?.cancel();
        const transient = response.status === 429 || response.status >= 500;
        if (transient && attempt < 2) {
          const retryAfter = Number(response.headers.get('retry-after'));
          await delay(
            Math.min(
              10000,
              Math.max(500 * 2 ** attempt, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0),
            ),
            undefined,
            { signal },
          );
          continue;
        }
        const message =
          response.status === 429
            ? 'Das Gemini-Kontingent ist momentan ausgeschöpft. Bitte später erneut versuchen.'
            : [401, 403].includes(response.status)
              ? 'Gemini hat den API-Zugang abgelehnt. Schlüssel, Freigaben und Projekt prüfen.'
              : response.status === 404
                ? 'Das ausgewählte Modell ist nicht mehr verfügbar. Bitte die Modellliste aktualisieren.'
                : 'Gemini konnte die Anfrage nicht verarbeiten. Modell, Kontextgröße und Zugang im Admin-Bereich prüfen.';
        throw new AppError(response.status === 429 ? 429 : 502, 'GEMINI_ERROR', message, transient);
      }
      return stream ? response : response.json();
    }
  }
  async models(key) {
    const models = [];
    const seen = new Set();
    let pageToken;
    do {
      const result = await this.request(
        `models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
        { key },
      );
      models.push(...(result.models || []));
      pageToken = result.nextPageToken;
      if (pageToken && seen.has(pageToken))
        throw new AppError(
          502,
          'MODEL_PAGINATION',
          'Die Modellliste konnte nicht vollständig geladen werden.',
        );
      if (pageToken) seen.add(pageToken);
      if (seen.size > 20)
        throw new AppError(502, 'MODEL_PAGINATION', 'Die Modellliste ist zu groß.');
    } while (pageToken);
    return {
      chat: models.filter(isChatModel).map((m) => ({
        name: m.name,
        displayName: m.displayName || m.name,
        inputTokenLimit: m.inputTokenLimit || 32768,
        outputTokenLimit: m.outputTokenLimit || 4096,
        supportedGenerationMethods: m.supportedGenerationMethods,
      })),
      embedding: models
        .filter(
          (m) =>
            m.supportedGenerationMethods?.includes('embedContent') &&
            /^models\/gemini-embedding-(001|2(?:[._-].*)?)$/.test(m.name),
        )
        .map((m) => ({ name: m.name, displayName: m.displayName || m.name })),
    };
  }
  async embed(texts, { query = false, model = this.embeddingModel(), signal, key } = {}) {
    if (!/^models\/[a-zA-Z0-9._-]+$/.test(model))
      throw new AppError(500, 'MODEL_INVALID', 'Ungültiges Embedding-Modell.');
    const secondGeneration = model.includes('embedding-2');
    const requests = texts.map((item) => ({
      model,
      content: {
        parts: [
          {
            text: secondGeneration
              ? query
                ? `task: search result | query: ${item.text}`
                : `title: ${item.title || 'none'} | text: ${item.text}`
              : item.text,
          },
        ],
      },
      ...(secondGeneration
        ? {}
        : {
            taskType: query ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
            ...(!query && item.title ? { title: item.title.slice(0, 300) } : {}),
          }),
      outputDimensionality: DIMENSIONS,
    }));
    const result = await this.request(`${model}:batchEmbedContents`, {
      body: { requests },
      signal,
      key,
    });
    if (result.embeddings?.length !== texts.length)
      throw new AppError(502, 'INVALID_EMBEDDING', 'Die Embeddings sind unvollständig.');
    return result.embeddings.map((e) => normalize(e.values));
  }
  async test(key, model, embeddingModel) {
    const result = await this.request(`${model}:generateContent`, {
      key,
      body: { contents: [{ role: 'user', parts: [{ text: 'Reply with OK.' }] }] },
    });
    if (!result.candidates?.[0]?.content?.parts?.some((p) => p.text && !p.thought))
      throw new AppError(502, 'NO_TEXT', 'Dieses Modell hat keine Textantwort geliefert.');
    await this.embed([{ text: 'Verbindungstest', title: 'Test' }], { key, model: embeddingModel });
    return true;
  }
  async countTokens(model, body, signal) {
    const result = await this.request(`${model}:countTokens`, {
      body: { generateContentRequest: { model, ...body } },
      signal,
    });
    return result.totalTokens;
  }
  async *stream(model, body, signal) {
    const response = await this.request(`${model}:streamGenerateContent?alt=sse`, {
      body,
      signal,
      stream: true,
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || '';
        if (done && buffer) {
          blocks.push(buffer);
          buffer = '';
        }
        for (const block of blocks) {
          const data = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          let event;
          try {
            event = JSON.parse(data);
          } catch {
            throw new AppError(502, 'INVALID_STREAM', 'Die Antwortübertragung wurde unterbrochen.');
          }
          if (event.error)
            throw new AppError(
              502,
              'STREAM_ERROR',
              'Gemini hat die Antwortübertragung abgebrochen.',
            );
          if (event.promptFeedback?.blockReason)
            throw new AppError(
              422,
              'CONTENT_BLOCKED',
              'Gemini hat diese Anfrage aufgrund seiner Inhaltsfilter nicht beantwortet.',
            );
          const candidate = event.candidates?.[0];
          if (candidate?.finishReason) finished = true;
          for (const part of candidate?.content?.parts || [])
            if (part.text && !part.thought) yield { type: 'delta', text: part.text };
          if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
            if (candidate.finishReason === 'MAX_TOKENS')
              yield {
                type: 'warning',
                message:
                  'Die Antwort hat die Ausgabelänge des Modells erreicht. Bitte gezielt nachfragen.',
              };
            else
              throw new AppError(
                422,
                'CONTENT_BLOCKED',
                'Gemini konnte die Antwort aufgrund seiner Inhaltsfilter nicht abschließen.',
              );
          }
        }
        if (done) break;
        if (buffer.length > 1000000)
          throw new AppError(502, 'INVALID_STREAM', 'Ungültige Antwortübertragung.');
      }
      if (!finished)
        throw new AppError(
          502,
          'STREAM_INCOMPLETE',
          'Die Antwortübertragung endete vor dem Abschluss des Modells. Bitte erneut versuchen.',
        );
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
