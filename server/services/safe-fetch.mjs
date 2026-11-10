import dns from 'node:dns/promises';
import net from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as request } from 'undici';
import { AppError } from '../lib/errors.mjs';

export function publicAddress(address) {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}
export function validateUrl(input, hostname) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new AppError(400, 'INVALID_URL', 'Bitte eine gültige HTTP(S)-Adresse eingeben.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    input.length > 2000 ||
    net.isIP(url.hostname.replace(/^\[|\]$/g, '')) ||
    !url.hostname.includes('.') ||
    /\.(local|localhost|internal|home|lan)$/i.test(url.hostname)
  ) {
    throw new AppError(
      400,
      'UNSAFE_URL',
      'Erlaubt sind öffentliche HTTP(S)-Webseiten mit Domainnamen und Standardport.',
    );
  }
  if (hostname && url.hostname !== hostname)
    throw new AppError(
      400,
      'EXTERNAL_LINK',
      'Links und Weiterleitungen auf andere Domains werden nicht verfolgt.',
    );
  url.hash = '';
  for (const name of [...url.searchParams.keys()])
    if (/^(utm_|fbclid$|gclid$)/i.test(name)) url.searchParams.delete(name);
  return url;
}
export async function safeFetch(
  input,
  {
    hostname,
    signal,
    maxBytes = 2 * 1024 * 1024,
    lookup = dns.lookup,
    fetchImpl = request,
    beforeRequest,
  } = {},
) {
  let url = validateUrl(input, hostname);
  const sameHost = hostname || url.hostname;
  const timeout = AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]);
  for (let redirects = 0; redirects <= 5; redirects++) {
    await beforeRequest?.(url.href);
    const addresses = await Promise.race([
      lookup(url.hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => {
        if (timeout.aborted) reject(timeout.reason);
        else timeout.addEventListener('abort', () => reject(timeout.reason), { once: true });
      }),
    ]);
    if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
      throw new AppError(
        400,
        'PRIVATE_NETWORK',
        'Diese Adresse führt in ein privates oder reserviertes Netzwerk.',
      );
    // Pin every socket to the already checked addresses. Never resolve again between validation and connect.
    const pinnedHostname = url.hostname;
    const dispatcher = new Agent({
      connect: {
        timeout: 10000,
        lookup: (host, options, callback) => {
          if (host !== pinnedHostname) return callback(new Error('Unexpected host'));
          const candidates = addresses.filter(
            (a) => !options.family || a.family === options.family,
          );
          if (!candidates.length) return callback(new Error('No valid address'));
          if (options.all) callback(null, candidates);
          else callback(null, candidates[0].address, candidates[0].family);
        },
      },
    });
    try {
      const response = await fetchImpl(url, {
        dispatcher,
        redirect: 'manual',
        signal: timeout,
        headers: {
          'User-Agent': 'WissensraumBot/1.0',
          Accept: 'text/html,text/plain;q=0.9',
          'Accept-Encoding': 'identity',
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || redirects === 5)
          throw new AppError(422, 'REDIRECT_LIMIT', 'Die Webseite leitet zu häufig weiter.');
        url = validateUrl(new URL(location, url).href, sameHost);
        continue;
      }
      if (Number(response.headers.get('content-length')) > maxBytes) {
        await response.body?.cancel();
        throw new AppError(422, 'PAGE_TOO_LARGE', 'Die Webseite überschreitet das Größenlimit.');
      }
      const chunks = [];
      let bytes = 0;
      if (response.body)
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > maxBytes)
            throw new AppError(
              422,
              'PAGE_TOO_LARGE',
              'Die Webseite überschreitet das Größenlimit.',
            );
          chunks.push(chunk);
        }
      return {
        status: response.status,
        url: url.href,
        contentType: response.headers.get('content-type') || '',
        text: Buffer.concat(chunks).toString('utf8'),
      };
    } finally {
      await dispatcher.destroy();
    }
  }
}
