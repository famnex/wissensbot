import React, { useEffect, useRef } from 'react';
import {
  LoaderCircle,
  CheckCircle2,
  AlertCircle,
  X,
  Layers,
  ChevronRight,
  ChevronLeft,
  Copy,
  Check,
  ExternalLink,
  Globe,
  Inbox,
  Paperclip,
  File,
  Image,
  Download,
} from 'lucide-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

export function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
export function Spinner() {
  return <LoaderCircle className="spin" size={18} aria-label="Wird geladen" />;
}

export function Notice({ children, kind = 'error' }) {
  return children ? (
    <div className={`notice ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {kind === 'success' ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
      <span>{children}</span>
    </div>
  ) : null;
}

export function Modal({ title, children, onClose, className = '' }) {
  const ref = useRef();
  useEffect(() => {
    ref.current.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${className}`.trim()}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="Dialog schließen">
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function Brand() {
  return (
    <div className="brand">
      <span className="brand-icon">
        <Layers size={23} />
      </span>
      <span>
        Wissensraum<span className="brand-sub">WISSEN VERBINDET.</span>
      </span>
    </div>
  );
}

export function Markdown({ text }) {
  const isWissenPath =
    typeof window !== 'undefined' && window.location.pathname.startsWith('/wissen');

  DOMPurify.removeHook('afterSanitizeAttributes');
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
      const href = node.getAttribute('href');
      if (href && href.startsWith('/api/') && isWissenPath) {
        node.setAttribute('href', `/wissen${href}`);
      }
    }
    if (node.tagName === 'IMG') {
      node.setAttribute('loading', 'lazy');
      node.classList.add('markdown-img');
      const src = node.getAttribute('src');
      if (src && src.startsWith('/api/') && isWissenPath) {
        node.setAttribute('src', `/wissen${src}`);
      }
    }
  });

  const html = DOMPurify.sanitize(marked.parse(text || '', { breaks: true, gfm: true }), {
    ALLOWED_TAGS: [
      'p',
      'br',
      'pre',
      'code',
      'strong',
      'em',
      'del',
      'a',
      'ul',
      'ol',
      'li',
      'blockquote',
      'h1',
      'h2',
      'h3',
      'h4',
      'hr',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'span',
      'img',
    ],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'target', 'rel', 'class', 'loading'],
    FORBID_TAGS: ['svg', 'style', 'form', 'input', 'iframe', 'video', 'audio'],
    FORBID_ATTR: ['style', 'id', 'name'],
  });
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Message({ message, user, streaming, notify }) {
  const bot = message.role === 'model';
  return (
    <article className={`message ${bot ? 'assistant-message' : 'user-message'}`}>
      <div className={`message-avatar ${bot ? 'bot-avatar' : ''}`}>
        {bot ? <Layers size={18} /> : user.name.slice(0, 1).toUpperCase()}
      </div>
      <div className="message-body">
        <div className="message-heading">
          <strong>{bot ? 'Wissensraum' : user.name}</strong>
          {streaming && (
            <span>
              <Spinner /> Antwort wird erstellt
            </span>
          )}
        </div>
        {message.text ? (
          <Markdown text={message.text} />
        ) : (
          <div className="thinking">
            <span />
            <span />
            <span />
            <span>Wissen durchsuchen …</span>
          </div>
        )}
        <Notice kind="info">{message.warning}</Notice>
        {bot && message.inboxRecorded && (
          <div className="inbox-notice">
            <Inbox size={15} />
            <span>In Wissens-Inbox vermerkt – diese Frage wurde für die Redaktion erfasst.</span>
          </div>
        )}
        {bot && (() => {
          const attachments = [];
          const seen = new Set();
          if (Array.isArray(message.sources)) {
            for (const s of message.sources) {
              if (Array.isArray(s.attachments)) {
                for (const att of s.attachments) {
                  if (!seen.has(att.id)) {
                    seen.add(att.id);
                    attachments.push(att);
                  }
                }
              }
            }
          }
          if (attachments.length === 0) return null;
          return (
            <div className="message-attachments">
              <span className="sources-label">
                <Paperclip size={12} /> ANGEHÄNGTE DATEIEN & BILDER ({attachments.length})
              </span>
              <div className="attachment-cards">
                {attachments.map((att) => {
                  const resolvedUrl =
                    typeof window !== 'undefined' &&
                    window.location.pathname.startsWith('/wissen') &&
                    att.url.startsWith('/api/')
                      ? `/wissen${att.url}`
                      : att.url;
                  return (
                    <a
                      key={att.id}
                      href={resolvedUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      download={!att.isImage ? att.name : undefined}
                      className={`attachment-card ${att.isImage ? 'is-image' : 'is-file'}`}
                      title={
                        att.isImage
                          ? `${att.name} (Bild in neuem Tab öffnen)`
                          : `${att.name} herunterladen`
                      }
                    >
                      <div className="attachment-card-icon">
                        {att.isImage ? (
                          <img
                            src={resolvedUrl}
                            alt={att.name}
                            className="attachment-card-thumb"
                            loading="lazy"
                          />
                        ) : (
                          <File size={20} />
                        )}
                      </div>
                      <div className="attachment-card-info">
                        <span className="attachment-card-name">{att.name}</span>
                        <span className="attachment-card-size">
                          {formatBytes(att.size)} · {att.isImage ? 'Bild' : 'Download'}
                        </span>
                      </div>
                      <span className="attachment-card-action">
                        {att.isImage ? <ExternalLink size={14} /> : <Download size={14} />}
                      </span>
                    </a>
                  );
                })}
              </div>
            </div>
          );
        })()}
        {bot && message.sources?.length > 0 && (
          <div className="citations">
            <span className="sources-label">ARTIKEL & QUELLEN</span>
            {message.sources.map((source) => {
              const displayTitle = source.chunkTitle || source.title;
              return (
                <details key={source.citation}>
                  <summary>
                    <span className="citation-number">{source.citation}</span>
                    <span title={displayTitle}>{displayTitle}</span>
                    {source.url && (
                      <span
                        className="citation-link-badge"
                        title={`Webseite verlinkt: ${source.url}`}
                      >
                        <Globe size={12} />
                      </span>
                    )}
                    <ChevronRight size={14} />
                  </summary>
                  <div className="citation-content">
                    <div className="citation-meta">
                      <strong>
                        {source.url ? (
                          <a
                            href={source.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="citation-title-link"
                            title={`${source.url} in neuem Tab öffnen`}
                          >
                            {displayTitle} <ExternalLink size={12} />
                          </a>
                        ) : (
                          displayTitle
                        )}
                      </strong>
                      {source.sourceTitle && source.sourceTitle !== displayTitle && (
                        <span className="citation-source-name">
                          Quelle:{' '}
                          {source.url ? (
                            <a
                              href={source.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="citation-source-link"
                              title={`${source.url} in neuem Tab öffnen`}
                            >
                              {source.sourceTitle} <ExternalLink size={11} />
                            </a>
                          ) : (
                            source.sourceTitle
                          )}
                        </span>
                      )}
                      {source.location && (
                        <span className="chunk-location-badge">{source.location}</span>
                      )}
                    </div>
                    <p>{source.text}</p>
                    {source.attachments?.length > 0 && (
                      <div className="citation-attachments">
                        <span className="citation-attachments-title">
                          <Paperclip size={11} /> Beiliegende Dateien:
                        </span>
                        <div className="citation-attachment-list">
                          {source.attachments.map((att) => {
                            const resUrl =
                              typeof window !== 'undefined' &&
                              window.location.pathname.startsWith('/wissen') &&
                              att.url.startsWith('/api/')
                                ? `/wissen${att.url}`
                                : att.url;
                            return (
                              <a
                                key={att.id}
                                href={resUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                download={!att.isImage ? att.name : undefined}
                                className="citation-attachment-pill"
                                title={
                                  att.isImage
                                    ? `${att.name} (Bild öffnen)`
                                    : `${att.name} herunterladen`
                                }
                              >
                                {att.isImage ? <Image size={11} /> : <File size={11} />}
                                <span>{att.name}</span>
                                <small>({formatBytes(att.size)})</small>
                              </a>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {source.url && (
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="citation-link"
                      >
                        Webseite öffnen <ExternalLink size={13} />
                      </a>
                    )}
                  </div>
                </details>
              );
            })}
          </div>
        )}
        {bot && message.text && !streaming && (
          <button
            className="copy-button"
            onClick={() =>
              navigator.clipboard
                .writeText(message.text)
                .then(() => notify('Antwort kopiert.'))
                .catch(() => notify('Bitte den Text markieren und manuell kopieren.'))
            }
          >
            <Copy size={14} /> Kopieren
          </button>
        )}
      </div>
    </article>
  );
}

export function Status({ source }) {
  const text = !source.active
    ? 'Pausiert'
    : { ready: 'Bereit', queued: 'Wartet', indexing: 'In Verarbeitung', error: 'Fehlgeschlagen' }[
        source.status
      ];
  return (
    <span className={`status ${!source.active ? 'paused' : source.status}`}>
      {source.active && source.status === 'ready' && <Check size={13} />} {text}
    </span>
  );
}

export function Stat({ label, value, icon: Icon }) {
  return (
    <div className="stat-card">
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <Icon size={23} />
    </div>
  );
}

export function Pagination({ page, total, pageSize, onChange }) {
  return (
    <div className="pagination">
      <span>
        Seite {page} von {Math.max(1, Math.ceil(total / pageSize))}
      </span>
      <div>
        <button
          className="icon-button"
          aria-label="Vorherige Seite"
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
        >
          <ChevronLeft size={18} />
        </button>
        <button
          className="icon-button"
          aria-label="Nächste Seite"
          disabled={page * pageSize >= total}
          onClick={() => onChange(page + 1)}
        >
          <ChevronRight size={18} />
        </button>
      </div>
    </div>
  );
}
