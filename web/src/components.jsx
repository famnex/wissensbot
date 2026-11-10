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
} from 'lucide-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
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
  const html = DOMPurify.sanitize(marked.parse(text, { breaks: true, gfm: true }), {
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
    ],
    FORBID_TAGS: ['img', 'svg', 'style', 'form', 'input', 'iframe', 'video', 'audio'],
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
