import * as cheerio from 'cheerio';
import robotsParser from 'robots-parser';
import { setTimeout as delay } from 'node:timers/promises';
import { safeFetch, validateUrl } from './safe-fetch.mjs';
import { AppError } from '../lib/errors.mjs';
import { MAX_TEXT } from './chunking.mjs';

export async function crawl(
  input,
  { maxPages = 40, progress = () => {}, signal, fetchPage = safeFetch, pause = delay } = {},
) {
  const root = validateUrl(input);
  const hostname = root.hostname;
  const combined = AbortSignal.any([
    AbortSignal.timeout(15 * 60 * 1000),
    ...(signal ? [signal] : []),
  ]);
  const robotsUrl = new URL('/robots.txt', root).href;
  const robotFile = await fetchPage(robotsUrl, {
    hostname,
    signal: combined,
    maxBytes: 512 * 1024,
  });
  if (![200, 404, 410].includes(robotFile.status))
    throw new AppError(
      422,
      'ROBOTS_UNAVAILABLE',
      'robots.txt lässt sich nicht sicher prüfen oder der Zugriff wird verweigert.',
    );
  const robots = robotsParser(robotsUrl, robotFile.status === 200 ? robotFile.text : '');
  const waitMs = Math.max(500, (robots.getCrawlDelay('WissensraumBot') || 0) * 1000);
  if (waitMs > 60000)
    throw new AppError(
      422,
      'CRAWL_DELAY',
      'Die Website verlangt eine längere Crawl-Pause als unterstützt.',
    );
  const queue = [{ url: root.href, depth: 0 }];
  const seen = new Set([root.href]);
  const documents = [];
  let failed = 0;
  let blocked = 0;
  let visited = 0;
  let total = 0;
  let capped = false;
  while (queue.length && visited < maxPages) {
    combined.throwIfAborted();
    const item = queue.shift();
    if (robots.isAllowed(item.url, 'WissensraumBot') === false) {
      if (item.depth === 0)
        throw new AppError(
          422,
          'ROBOTS_BLOCKED',
          'robots.txt erlaubt das Crawlen dieser Startseite nicht.',
        );
      blocked++;
      continue;
    }
    if (visited) await pause(waitMs, undefined, { signal: combined });
    visited++;
    progress(
      Math.min(55, 5 + Math.floor((visited / maxPages) * 50)),
      `${visited} Seite(n) geprüft · Tiefe ${item.depth}/2`,
    );
    let page;
    try {
      page = await fetchPage(item.url, {
        hostname,
        signal: combined,
        beforeRequest: (url) => {
          if (robots.isAllowed(url, 'WissensraumBot') === false)
            throw new AppError(
              422,
              'ROBOTS_BLOCKED',
              'robots.txt sperrt diese Seite oder Weiterleitung.',
            );
        },
      });
      // A redirect target must also be permitted by robots.txt.
      if (robots.isAllowed(page.url, 'WissensraumBot') === false)
        throw new AppError(
          422,
          'ROBOTS_BLOCKED',
          'Das Weiterleitungsziel wird durch robots.txt gesperrt.',
        );
      if (page.status < 200 || page.status >= 300)
        throw new AppError(
          422,
          'PAGE_UNAVAILABLE',
          'Die Webseite ist nicht erreichbar oder verweigert den Zugriff.',
        );
      if (!/text\/html|application\/xhtml\+xml|text\/plain/i.test(page.contentType))
        throw new AppError(
          422,
          'UNSUPPORTED_PAGE',
          'Der Crawler liest HTML- und Textseiten. Dateien bitte direkt hochladen.',
        );
    } catch (error) {
      if (item.depth === 0 || combined.aborted) throw error;
      failed++;
      continue;
    }
    const $ = cheerio.load(page.text);
    const links = $('a[href]')
      .slice(0, 1500)
      .map((_i, el) => $(el).attr('href'))
      .get();
    const title = $('title').first().text().trim() || page.url;
    $('script,style,noscript,nav,footer,header,form,svg,iframe,template').remove();
    $('p,div,li,br,h1,h2,h3,h4,tr,section,article').append('\n');
    const main = $('main').first().length
      ? $('main').first()
      : $('article').first().length
        ? $('article').first()
        : $('body');
    const text = /text\/plain/.test(page.contentType)
      ? page.text
      : main
          .text()
          .replace(/[ \t]+/g, ' ')
          .replace(/\n\s*\n/g, '\n')
          .trim();
    total += text.length;
    if (total > MAX_TEXT)
      throw new AppError(
        422,
        'CRAWL_TOO_LARGE',
        'Der Crawl enthält zu viel Text. Bitte eine spezifischere Startadresse verwenden.',
      );
    if (text) documents.push({ text, title, location: title.slice(0, 300), url: page.url });
    if (item.depth >= 2) continue;
    for (const href of links) {
      try {
        const next = validateUrl(new URL(href, page.url).href, hostname);
        if (
          /\.(pdf|docx?|xlsx?|zip|png|jpe?g|gif|mp4|svg|css|js)$/i.test(next.pathname) ||
          seen.has(next.href)
        )
          continue;
        if (seen.size >= maxPages) {
          capped = true;
          continue;
        }
        seen.add(next.href);
        queue.push({ url: next.href, depth: item.depth + 1 });
      } catch {
        /* External, non-HTTP, credentialed and unsafe links are never followed. */
      }
    }
  }
  if (!documents.length)
    throw new AppError(
      422,
      'EMPTY_CRAWL',
      'Auf diesen Seiten wurde kein lesbarer Text gefunden. JavaScript-Webseiten benötigen einen Text-Export.',
    );
  const notes = [
    failed ? `${failed} Unterseite(n) konnten nicht gelesen werden.` : '',
    blocked ? `${blocked} Seite(n) durch robots.txt ausgeschlossen.` : '',
    capped || queue.length ? `Seitenlimit (${maxPages}) erreicht.` : '',
  ].filter(Boolean);
  return { documents, warning: notes.join(' ') || null };
}
