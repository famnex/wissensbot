export async function api(path, { method = 'GET', body, token, signal } = {}) {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    signal,
    headers: {
      'X-CSRF-Guard': '1',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(
      'Die Anwendung ist gerade nicht erreichbar. Bitte kurz warten und erneut versuchen.',
    );
  }
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/'))
      window.dispatchEvent(new Event('session-expired'));
    const error = new Error(result.error?.message || 'Die Anfrage ist fehlgeschlagen.');
    error.code = result.error?.code;
    throw error;
  }
  return result;
}
export async function streamChat(messages, onEvent, signal) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Guard': '1' },
    body: JSON.stringify({ messages: messages.map(({ role, text }) => ({ role, text })) }),
    signal,
  });
  if (!response.ok) {
    let data;
    try {
      data = await response.json();
    } catch {}
    if (response.status === 401) window.dispatchEvent(new Event('session-expired'));
    throw new Error(data?.error?.message || 'Die Antwort konnte nicht gestartet werden.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || '';
      for (const block of blocks) {
        const line = block.split(/\r?\n/).find((l) => l.startsWith('data:'));
        if (!line) continue;
        const event = JSON.parse(line.slice(5));
        if (event.type === 'error') throw new Error(event.message);
        if (event.type === 'done') completed = true;
        onEvent(event);
      }
      if (done) break;
    }
    if (!completed)
      throw new Error(
        'Die Verbindung wurde unterbrochen. Deine Frage wurde wieder in das Eingabefeld übernommen.',
      );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export function uploadFile(file, title, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/sources/upload');
    xhr.setRequestHeader('X-CSRF-Guard', '1');
    xhr.timeout = 120000;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onerror = () => reject(new Error('Die Übertragung wurde unterbrochen.'));
    xhr.ontimeout = () => reject(new Error('Die Übertragung hat zu lange gedauert.'));
    xhr.onload = () => {
      let data;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        return reject(new Error('Die Übertragung ist fehlgeschlagen.'));
      }
      if (xhr.status === 401) window.dispatchEvent(new Event('session-expired'));
      xhr.status < 300
        ? resolve(data)
        : reject(new Error(data.error?.message || 'Upload fehlgeschlagen.'));
    };
    const form = new FormData();
    form.append('title', title || file.name);
    form.append('file', file);
    xhr.send(form);
  });
}

export function uploadImport(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/sources/import');
    xhr.setRequestHeader('X-CSRF-Guard', '1');
    xhr.timeout = 180000;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress)
        onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onerror = () => reject(new Error('Die Übertragung wurde unterbrochen.'));
    xhr.ontimeout = () => reject(new Error('Die Übertragung hat zu lange gedauert.'));
    xhr.onload = () => {
      let data;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        return reject(new Error('Der Import ist fehlgeschlagen.'));
      }
      if (xhr.status === 401) window.dispatchEvent(new Event('session-expired'));
      xhr.status < 300
        ? resolve(data)
        : reject(new Error(data.error?.message || 'Import fehlgeschlagen.'));
    };
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
}

export async function downloadExport(path, defaultFilename = 'wissensraum-export.json') {
  const response = await fetch(`/api${path}`, {
    method: 'GET',
    credentials: 'same-origin',
    headers: { 'X-CSRF-Guard': '1' },
  });
  if (!response.ok) {
    let msg = 'Export fehlgeschlagen.';
    try {
      const err = await response.json();
      msg = err.error?.message || msg;
    } catch {}
    throw new Error(msg);
  }
  const blob = await response.blob();
  let filename = defaultFilename;
  const disposition = response.headers.get('content-disposition');
  if (disposition && disposition.includes('filename=')) {
    const match = disposition.match(/filename="?([^"]+)"?/);
    if (match && match[1]) filename = match[1];
  }
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}
