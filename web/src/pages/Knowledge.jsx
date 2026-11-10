import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Plus,
  Database,
  BookOpen,
  RefreshCw,
  Search,
  Globe,
  FileText,
  Pause,
  Play,
  Trash2,
  AlertCircle,
  ShieldCheck,
  Upload,
  Link,
  ChevronDown,
  ChevronRight,
  Pencil,
  Layers,
  Download,
  ExternalLink,
  FileUp,
} from 'lucide-react';
import { Notice, Spinner, Modal, Stat, Status, Pagination } from '../components';
import { api, uploadFile, uploadImport, downloadExport } from '../api';
import { date } from '../shared';
export function Knowledge({ overview, notify, refresh, initialOpen, onOpened, initialData }) {
  const [sources, setSources] = useState([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [add, setAdd] = useState(Boolean(initialOpen || initialData));
  const [remove, setRemove] = useState(null);
  const [busy, setBusy] = useState('');
  const [expandedSourceId, setExpandedSourceId] = useState(null);
  const [renamingSource, setRenamingSource] = useState(null);
  const [importModal, setImportModal] = useState(false);
  const [exportingAll, setExportingAll] = useState(false);

  useEffect(() => {
    onOpened();
  }, []);
  const reload = useCallback(async () => {
    try {
      const data = await api(`/sources?page=${page}&q=${encodeURIComponent(query)}`);
      setSources(data.sources);
      setTotal(data.total);
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [query, page]);
  useEffect(() => {
    setLoading(true);
    const t = setTimeout(reload, 200);
    const poll = setInterval(reload, 3000);
    return () => {
      clearTimeout(t);
      clearInterval(poll);
    };
  }, [reload]);
  async function action(source, kind) {
    setBusy(source.id);
    setError('');
    try {
      if (kind === 'delete') await api(`/sources/${source.id}`, { method: 'DELETE' });
      else if (kind === 'reindex') await api(`/sources/${source.id}/reindex`, { method: 'POST' });
      else
        await api(`/sources/${source.id}`, { method: 'PATCH', body: { active: !source.active } });
      setRemove(null);
      await reload();
      refresh();
      notify(
        kind === 'delete'
          ? 'Quelle gelöscht.'
          : kind === 'reindex'
            ? 'Indexierung gestartet.'
            : source.active
              ? 'Quelle pausiert. Sie wird für neue Suchanfragen nicht mehr verwendet.'
              : 'Quelle wieder aktiviert.',
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }

  async function handleExportSingle(source) {
    try {
      const sanitized =
        source.title
          .toLowerCase()
          .replace(/[^a-z0-9_-]/gi, '_')
          .slice(0, 40) || 'quelle';
      await downloadExport(`/sources/${source.id}/export`, `wissensraum-${sanitized}.json`);
      notify(`Quelle "${source.title}" erfolgreich exportiert.`);
    } catch (e) {
      setError(e.message);
    }
  }

  async function handleExportAll() {
    setExportingAll(true);
    try {
      const dateStr = new Date().toISOString().slice(0, 10);
      await downloadExport('/sources/export', `wissensraum-export-all-${dateStr}.json`);
      notify('Gesamte Wissensbasis erfolgreich exportiert.');
    } catch (e) {
      setError(e.message);
    } finally {
      setExportingAll(false);
    }
  }

  return (
    <div className="page-wrap">
      <div className="page-heading">
        <div>
          <span className="eyebrow">GEMEINSAMES WISSEN</span>
          <h1>Wissensbasis</h1>
          <p>Die Grundlage für verlässliche Antworten.</p>
        </div>
        <div className="heading-actions">
          <button
            type="button"
            className="button secondary"
            onClick={() => setImportModal(true)}
            title="Quellen aus JSON-Exportdatei importieren"
          >
            <Upload size={16} /> Quellen importieren
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={handleExportAll}
            disabled={exportingAll || total === 0}
            title="Gesamte Wissensbasis als JSON exportieren"
          >
            {exportingAll ? <Spinner /> : <Download size={16} />} Alle exportieren
          </button>
          <button type="button" className="button primary" onClick={() => setAdd(true)}>
            <Plus size={18} /> Wissen hinzufügen
          </button>
        </div>
      </div>
      <div className="stats-grid">
        <Stat label="Artikel verfügbar" value={overview?.readyArticles ?? overview?.ready ?? '–'} icon={BookOpen} />
        <Stat label="Artikel insgesamt" value={overview?.totalArticles ?? overview?.chunks ?? '–'} icon={Database} />
        <Stat label="Quellen in Arbeit" value={overview?.queued ?? '–'} icon={RefreshCw} />
      </div>
      <Notice>{error}</Notice>
      {overview?.workerOnline === false && (
        <Notice kind="info">
          Die Hintergrundverarbeitung ist gerade nicht erreichbar. Neue Aufträge bleiben in der
          Warteschlange.
        </Notice>
      )}
      <section className="panel">
        <div className="panel-toolbar">
          <h2>
            Alle Quellen <span className="count-pill">{total}</span>
          </h2>
          <div className="search-box">
            <Search size={17} />
            <input
              aria-label="Quellen durchsuchen"
              placeholder="Quellen suchen …"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
          </div>
        </div>
        {loading && sources.length === 0 ? (
          <div className="empty-state">
            <Spinner /> Quellen laden …
          </div>
        ) : sources.length === 0 ? (
          <div className="empty-state">
            <Database size={34} />
            <h3>{query ? 'Keine Treffer' : 'Hier beginnt eure Wissensbasis'}</h3>
            <p>
              {query
                ? 'Versuche einen anderen Suchbegriff.'
                : 'Füge eine Notiz, eine Datei oder eine Website hinzu.'}
            </p>
            {!query && (
              <button className="button secondary" onClick={() => setAdd(true)}>
                <Plus size={17} /> Erste Quelle hinzufügen
              </button>
            )}
          </div>
        ) : (
          <div className="source-list">
            <div className="source-row source-labels">
              <span>QUELLE</span>
              <span>STATUS</span>
              <span>ARTIKEL</span>
              <span>AKTIONEN</span>
            </div>
            {sources.map((source) => (
              <div className="source-item" key={source.id}>
                <div className="source-row">
                  <div className="source-title">
                    <span className={`source-icon type-${source.type}`}>
                      {source.type === 'url' ? (
                        <Globe size={20} />
                      ) : source.type === 'file' ? (
                        <FileText size={20} />
                      ) : (
                        <BookOpen size={20} />
                      )}
                    </span>
                    <div>
                      {source.type === 'url' && source.reference ? (
                        <a
                          href={source.reference}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="source-title-link"
                          title={`${source.reference} in neuem Tab öffnen`}
                        >
                          <strong>{source.title}</strong>
                          <ExternalLink size={13} className="inline-link-icon" />
                        </a>
                      ) : (
                        <strong>{source.title}</strong>
                      )}
                      <small>
                        {source.type === 'url'
                          ? 'Webseite'
                          : source.type === 'file'
                            ? 'Datei'
                            : 'Wissensnotiz'}{' '}
                        · {date(source.created_at)}
                      </small>
                      {source.type === 'url' && source.reference && (
                        <a
                          href={source.reference}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="source-url-link"
                          title={`${source.reference} in neuem Tab öffnen`}
                        >
                          <Globe size={11} />
                          <span>{source.reference}</span>
                          <ExternalLink size={11} />
                        </a>
                      )}
                    </div>
                  </div>
                  <div>
                    <Status source={source} />
                  </div>
                  <div className="chunk-cell">
                    <button
                      type="button"
                      className={`chunk-pill-btn ${expandedSourceId === source.id ? 'active' : ''}`}
                      onClick={() => setExpandedSourceId(expandedSourceId === source.id ? null : source.id)}
                      title={
                        source.chunk_count
                          ? `${source.chunk_count} Wissensartikel einsehen & anpassen`
                          : 'Wissensartikel anzeigen'
                      }
                      aria-expanded={expandedSourceId === source.id}
                    >
                      <Layers size={13} />
                      <span>{source.chunk_count || 0}</span>
                      {expandedSourceId === source.id ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    </button>
                  </div>
                  <div className="row-actions">
                    {busy === source.id ? (
                      <Spinner />
                    ) : (
                      <>
                        <button
                          type="button"
                          className="icon-button"
                          title="Quelle umbenennen"
                          aria-label={`${source.title} umbenennen`}
                          onClick={() => setRenamingSource(source)}
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          title="Quelle als JSON exportieren"
                          aria-label={`${source.title} als JSON exportieren`}
                          onClick={() => handleExportSingle(source)}
                        >
                          <Download size={16} />
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          disabled={source.status === 'queued' || source.status === 'indexing'}
                          title="Neu indexieren"
                          aria-label={`${source.title} neu indexieren`}
                          onClick={() => action(source, 'reindex')}
                        >
                          <RefreshCw size={16} />
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          title={source.active ? 'Pausieren' : 'Aktivieren'}
                          aria-label={`${source.title} ${source.active ? 'pausieren' : 'aktivieren'}`}
                          onClick={() => action(source, 'toggle')}
                        >
                          {source.active ? <Pause size={16} /> : <Play size={16} />}
                        </button>
                        <button
                          type="button"
                          className="icon-button danger-icon"
                          title="Löschen"
                          aria-label={`${source.title} löschen`}
                          onClick={() => setRemove(source)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {['queued', 'indexing'].includes(source.status) && (
                  <div className="source-progress">
                    <progress max="100" value={source.progress || 0} />
                    <span>
                      {source.stage || 'Warteschlange'} · {source.progress || 0}%
                    </span>
                  </div>
                )}
                {(source.error || source.warning) && (
                  <div className={`source-note ${source.error ? 'error-text' : ''}`}>
                    <AlertCircle size={15} />
                    {source.error || source.warning}
                  </div>
                )}
                {expandedSourceId === source.id && (
                  <SourceChunksDrawer
                    source={source}
                    notify={notify}
                    refresh={refresh}
                    onSourceUpdated={reload}
                    onExportSingle={handleExportSingle}
                  />
                )}
              </div>
            ))}
          </div>
        )}
        {total > 25 && <Pagination page={page} pageSize={25} total={total} onChange={setPage} />}
      </section>
      <p className="page-footnote">
        <ShieldCheck size={15} /> Pausierte Quellen werden nicht für neue Suchanfragen verwendet.
        Bereits angezeigte Antworten bleiben im aktuellen Gespräch sichtbar.
      </p>
      {renamingSource && (
        <RenameSourceModal
          source={renamingSource}
          onClose={() => setRenamingSource(null)}
          onRenamed={(updated) => {
            setSources((prev) => prev.map((s) => (s.id === updated.id ? { ...s, ...updated } : s)));
            setRenamingSource(null);
            refresh();
            notify(`Quelle erfolgreich umbenannt in "${updated.title}".`);
          }}
        />
      )}
      {importModal && (
        <ImportSourcesModal
          onClose={() => setImportModal(false)}
          onImported={(res) => {
            setImportModal(false);
            reload();
            refresh();
            notify(`${res.importedCount || 1} Quelle(n) erfolgreich importiert.`);
          }}
        />
      )}
      {add && (
        <AddSource
          initialTab={initialOpen === 'file' ? 'file' : 'text'}
          initialTitle={initialData?.title || ''}
          initialText={initialData?.text || ''}
          maxMb={overview?.uploadMaxMb || 20}
          crawlMaxPages={overview?.crawlMaxPages || 40}
          onClose={() => setAdd(false)}
          onSaved={() => {
            setAdd(false);
            reload();
            refresh();
            notify('Quelle hinzugefügt. Die Verarbeitung läuft im Hintergrund.');
          }}
        />
      )}
      {remove && (
        <Modal title="Quelle dauerhaft löschen?" onClose={() => setRemove(null)}>
          <p>
            <strong>{remove.title}</strong>
          </p>
          <p>
            Die Quelle, ihr gespeicherter Text und alle zugehörigen Suchabschnitte werden gelöscht.
            Bereits erstellte Backups bleiben bestehen.
          </p>
          <div className="modal-actions">
            <button className="button secondary" onClick={() => setRemove(null)}>
              Abbrechen
            </button>
            <button
              className="button danger"
              disabled={Boolean(busy)}
              onClick={() => action(remove, 'delete')}
            >
              {busy ? <Spinner /> : <Trash2 size={17} />} Quelle löschen
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function AddSource({
  onClose,
  onSaved,
  initialTab = 'text',
  maxMb,
  crawlMaxPages,
  initialTitle = '',
  initialText = '',
}) {
  const [tab, setTab] = useState(initialTab);
  const [title, setTitle] = useState(initialTitle);
  const [text, setText] = useState(initialText);
  const [url, setUrl] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState('');
  const fileInput = useRef();
  function choose(file) {
    if (file && file.size > maxMb * 1024 * 1024) {
      setError(`Die Datei darf höchstens ${maxMb} MB groß sein.`);
      return;
    }
    setFile(file);
    setError('');
    if (file && !title) setTitle(file.name);
  }
  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (tab === 'file') {
        if (!file) throw new Error('Bitte eine Datei auswählen.');
        await uploadFile(file, title, setPercent);
      } else if (tab === 'text')
        await api('/sources/text', { method: 'POST', body: { title, text } });
      else await api('/sources/url', { method: 'POST', body: { title, url } });
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Wissen hinzufügen"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="tabs" role="tablist" aria-label="Art der Wissensquelle">
        {[
          ['text', BookOpen, 'Text'],
          ['file', Upload, 'Datei'],
          ['url', Link, 'Webseite'],
        ].map(([value, Icon, label]) => (
          <button
            role="tab"
            aria-selected={tab === value}
            key={value}
            onClick={() => {
              setTab(value);
              setError('');
            }}
            disabled={busy}
            className={tab === value ? 'active' : ''}
          >
            <Icon size={17} />
            {label}
          </button>
        ))}
      </div>
      <form onSubmit={submit}>
        <label htmlFor="source-title">
          Titel {tab === 'url' && <span className="optional">(optional)</span>}
        </label>
        <input
          id="source-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Ein aussagekräftiger Name"
          maxLength={200}
          required={tab !== 'url'}
          disabled={busy}
        />
        {tab === 'text' && (
          <>
            <label htmlFor="source-text">Wissenstext</label>
            <textarea
              id="source-text"
              rows={8}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Beschreibe das Wissen so konkret wie möglich …"
              maxLength={200000}
              required
              disabled={busy}
            />
            <p className="field-help">
              Zum Beispiel Abläufe, Anleitungen, Zuständigkeiten oder häufige Fragen.
            </p>
          </>
        )}
        {tab === 'file' && (
          <>
            <input
              ref={fileInput}
              className="visually-hidden"
              type="file"
              accept=".pdf,.docx,.xlsx,.csv,.txt,.md,.sql,.json"
              aria-label="Wissensdatei auswählen"
              onChange={(e) => choose(e.target.files[0])}
              disabled={busy}
            />
            <button
              type="button"
              className="dropzone"
              disabled={busy}
              onClick={() => fileInput.current.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (!busy) choose(e.dataTransfer.files[0]);
              }}
            >
              <Upload size={28} />
              <strong>{file ? file.name : 'Datei auswählen oder hierher ziehen'}</strong>
              <span>PDF, DOCX, XLSX, CSV, TXT, MD, SQL, JSON · bis {maxMb} MB</span>
            </button>
            <p className="field-help">
              PDFs benötigen eine Textebene. Formeln in Tabellen werden über ihre gespeicherten
              Ergebnisse gelesen.
            </p>
            {busy && (
              <div className="upload-progress">
                <progress value={percent} max="100" />
                <span>
                  {percent < 100
                    ? `Datei übertragen · ${percent}%`
                    : 'Übertragung abgeschlossen. Auftrag wird angelegt …'}
                </span>
              </div>
            )}
          </>
        )}
        {tab === 'url' && (
          <>
            <label htmlFor="source-url">Startadresse</label>
            <input
              id="source-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://beispiel.de/wissen"
              required
              maxLength={2000}
              disabled={busy}
            />
            <div className="crawl-rules">
              <Globe size={20} />
              <div>
                <strong>Die Website wird im Hintergrund eingelesen.</strong>
                <p>
                  Gleiche Domain · maximal 2 Link-Ebenen · bis zu {crawlMaxPages} Seiten. robots.txt
                  wird beachtet.
                </p>
              </div>
            </div>
          </>
        )}
        <Notice>{error}</Notice>
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose} disabled={busy}>
            Abbrechen
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? <Spinner /> : <Plus size={17} />}{' '}
            {busy ? 'Wird übergeben …' : 'Wissen hinzufügen'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SourceChunksDrawer({ source, notify, refresh, onSourceUpdated, onExportSingle }) {
  const [chunks, setChunks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingChunk, setEditingChunk] = useState(null);
  const [adding, setAdding] = useState(false);
  const [deletingChunk, setDeletingChunk] = useState(null);

  const fetchChunks = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api(`/sources/${source.id}/chunks`);
      setChunks(data.chunks || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [source.id]);

  useEffect(() => {
    fetchChunks();
  }, [fetchChunks]);

  return (
    <div className="source-chunks-drawer">
      <div className="chunks-drawer-header">
        <div>
          <h4>
            <Layers size={16} />
            Abgeleitete Wissensartikel ({chunks.length})
          </h4>
          <p className="chunks-subtitle">
            Aus{' '}
            {source.type === 'url' && source.reference ? (
              <a
                href={source.reference}
                target="_blank"
                rel="noopener noreferrer"
                className="source-inline-link"
                title={`${source.reference} in neuem Tab öffnen`}
              >
                <strong>{source.title}</strong> <ExternalLink size={12} />
              </a>
            ) : (
              <strong>{source.title}</strong>
            )}{' '}
            abgeleitete Wissensartikel mit Titeln, Fundstellen und Inhalten für verlässliche KI-Antworten.
          </p>
        </div>
        <div className="chunks-header-actions">
          {onExportSingle && (
            <button
              type="button"
              className="button secondary small"
              title="Diese Quelle als JSON exportieren"
              onClick={() => onExportSingle(source)}
            >
              <Download size={14} /> Exportieren
            </button>
          )}
          <button
            type="button"
            className="button secondary small"
            onClick={() => setAdding(true)}
          >
            <Plus size={14} /> Artikel hinzufügen
          </button>
          <button
            type="button"
            className="icon-button"
            title="Wissensartikel neu laden"
            onClick={fetchChunks}
          >
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </div>

      <Notice>{error}</Notice>

      {loading && chunks.length === 0 ? (
        <div className="chunks-loading">
          <Spinner /> Wissensartikel werden geladen …
        </div>
      ) : chunks.length === 0 ? (
        <div className="chunks-empty">
          <Layers size={30} />
          <h4>Noch keine Wissensartikel</h4>
          <p>
            {source.status === 'indexing' || source.status === 'queued'
              ? 'Die Quelle wird aktuell noch verarbeitet. Die Wissensartikel erscheinen hier automatisch, sobald die Indexierung abgeschlossen ist.'
              : 'Aus dieser Quelle wurden noch keine Wissensartikel erzeugt. Du kannst direkt einen neuen Artikel anlegen.'}
          </p>
          <button
            type="button"
            className="button secondary small"
            onClick={() => setAdding(true)}
          >
            <Plus size={14} /> Ersten Artikel anlegen
          </button>
        </div>
      ) : (
        <div className="chunks-grid">
          {chunks.map((chunk) => (
            <div key={chunk.id} className="chunk-card">
              <div className="chunk-card-header">
                <div className="chunk-card-meta">
                  <span className="chunk-ordinal">#{chunk.ordinal + 1}</span>
                  <strong className="chunk-title" title={chunk.title || 'Ohne Titel'}>
                    {chunk.title || 'Ohne Titel'}
                  </strong>
                </div>
                <div className="chunk-card-actions">
                  <button
                    type="button"
                    className="icon-button"
                    title="Wissensartikel bearbeiten & anpassen"
                    aria-label={`Artikel ${chunk.title || chunk.id} bearbeiten`}
                    onClick={() => setEditingChunk(chunk)}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-button danger-icon"
                    title="Wissensartikel löschen"
                    aria-label={`Artikel ${chunk.title || chunk.id} löschen`}
                    onClick={() => setDeletingChunk(chunk)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              {(chunk.location || chunk.url || (source.type === 'url' && source.reference)) && (
                <div className="chunk-location-row">
                  {chunk.location && (
                    <span className="chunk-location-badge" title={chunk.location}>
                      {chunk.location}
                    </span>
                  )}
                  {(chunk.url || (source.type === 'url' && source.reference)) && (
                    <a
                      href={chunk.url || source.reference}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="chunk-link-badge"
                      title={`${chunk.url || source.reference} in neuem Tab öffnen`}
                    >
                      <Globe size={11} />
                      <span>Webseite</span>
                      <ExternalLink size={10} />
                    </a>
                  )}
                </div>
              )}
              <div className="chunk-text-box">
                {chunk.text}
              </div>
              <div className="chunk-card-footer">
                <span>{chunk.text ? chunk.text.length : 0} Zeichen</span>
                <button
                  type="button"
                  className="text-link"
                  onClick={() => setEditingChunk(chunk)}
                >
                  Einsehen & anpassen
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editingChunk && (
        <EditChunkModal
          source={source}
          chunk={editingChunk}
          onClose={() => setEditingChunk(null)}
          onSaved={(updated) => {
            setChunks((prev) =>
              prev.map((c) => (c.id === updated.id ? { ...c, ...updated } : c)),
            );
            setEditingChunk(null);
            refresh();
            notify('Wissensartikel erfolgreich aktualisiert und neu vektorisiert.');
          }}
        />
      )}

      {adding && (
        <AddChunkModal
          source={source}
          onClose={() => setAdding(false)}
          onSaved={(newChunk) => {
            setChunks((prev) => [...prev, newChunk]);
            setAdding(false);
            onSourceUpdated();
            refresh();
            notify('Neuer Wissensartikel hinzugefügt und vektorisiert.');
          }}
        />
      )}

      {deletingChunk && (
        <DeleteChunkModal
          source={source}
          chunk={deletingChunk}
          onClose={() => setDeletingChunk(null)}
          onDeleted={(deletedId) => {
            setChunks((prev) => prev.filter((c) => c.id !== deletedId));
            setDeletingChunk(null);
            onSourceUpdated();
            refresh();
            notify('Wissensartikel gelöscht.');
          }}
        />
      )}
    </div>
  );
}

function EditChunkModal({ source, chunk, onClose, onSaved }) {
  const [title, setTitle] = useState(chunk.title || '');
  const [location, setLocation] = useState(chunk.location || '');
  const [text, setText] = useState(chunk.text || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (!text.trim()) {
      setError('Der Text darf nicht leer sein.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await api(`/sources/${source.id}/chunks/${chunk.id}`, {
        method: 'PATCH',
        body: { title, location, text },
      });
      onSaved(res.chunk);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      className="modal-large"
      title="Wissensartikel anpassen & korrigieren"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="chunk-modal-source-info">
        <span className="source-label">Quelle:</span> <strong>{source.title}</strong> · Artikel #{chunk.ordinal + 1}
      </div>
      <form onSubmit={submit}>
        <label htmlFor="chunk-edit-title">Titel des Wissensartikels</label>
        <input
          id="chunk-edit-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Aussagekräftiger Titel (z. B. Abrechnungsfristen oder Support-Kontakt)"
          maxLength={200}
          disabled={busy}
        />
        <label htmlFor="chunk-edit-location">Fundstelle / Position <span className="optional">(optional)</span></label>
        <input
          id="chunk-edit-location"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="z. B. Seite 3, Abschnitt 2 oder URL"
          maxLength={300}
          disabled={busy}
        />
        <label htmlFor="chunk-edit-text">Inhalt des Wissensartikels</label>
        <textarea
          id="chunk-edit-text"
          rows={10}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Der eigentliche Wissenstext..."
          required
          disabled={busy}
        />
        <p className="field-help">
          💡 <strong>Hinweis zur KI-Verarbeitung:</strong> Beim Speichern wird der Text automatisch neu analysiert und der Vektor-Index mit Gemini-Embeddings aktualisiert, sodass die KI Ihre Anpassungen sofort präzise für Antworten nutzt.
        </p>
        <Notice>{error}</Notice>
        <div className="modal-actions">
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={busy}
          >
            Abbrechen
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? <Spinner /> : null}
            {busy ? 'Wird gespeichert & neu vektorisiert …' : 'Speichern & Neu vektorisieren'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AddChunkModal({ source, onClose, onSaved }) {
  const [title, setTitle] = useState('');
  const [location, setLocation] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (!text.trim()) {
      setError('Bitte gib einen Text für den Wissensartikel ein.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await api(`/sources/${source.id}/chunks`, {
        method: 'POST',
        body: { title, location, text },
      });
      onSaved(res.chunk);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      className="modal-large"
      title="Neuen Wissensartikel anlegen"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="chunk-modal-source-info">
        <span className="source-label">Quelle:</span> <strong>{source.title}</strong>
      </div>
      <form onSubmit={submit}>
        <label htmlFor="chunk-new-title">Titel <span className="optional">(optional – wird sonst automatisch abgeleitet)</span></label>
        <input
          id="chunk-new-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="z. B. Wichtige Rufnummern im Notfall"
          maxLength={200}
          disabled={busy}
        />
        <label htmlFor="chunk-new-location">Fundstelle / Position <span className="optional">(optional)</span></label>
        <input
          id="chunk-new-location"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="z. B. Manuelle Ergänzung, Notiz"
          maxLength={300}
          disabled={busy}
        />
        <label htmlFor="chunk-new-text">Inhalt des Wissensartikels</label>
        <textarea
          id="chunk-new-text"
          rows={10}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Wissenstext eingeben …"
          required
          disabled={busy}
        />
        <p className="field-help">
          Dieser Artikel wird sofort in den Vektor-Index aufgenommen und steht für Antworten bereit.
        </p>
        <Notice>{error}</Notice>
        <div className="modal-actions">
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={busy}
          >
            Abbrechen
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? <Spinner /> : <Plus size={16} />}
            {busy ? 'Wird gespeichert & vektorisiert …' : 'Artikel anlegen'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteChunkModal({ source, chunk, onClose, onDeleted }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function remove() {
    setBusy(true);
    setError('');
    try {
      await api(`/sources/${source.id}/chunks/${chunk.id}`, { method: 'DELETE' });
      onDeleted(chunk.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Wissensartikel löschen?"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="chunk-modal-source-info">
        <span className="source-label">Quelle:</span> <strong>{source.title}</strong>
      </div>
      <p>
        Soll der Artikel <strong>#{chunk.ordinal + 1}: {chunk.title || 'Ohne Titel'}</strong> wirklich gelöscht werden?
      </p>
      <div className="chunk-delete-preview">
        {chunk.text ? (chunk.text.length > 200 ? chunk.text.slice(0, 200) + '…' : chunk.text) : ''}
      </div>
      <p className="field-help">
        Dieser Wissensartikel und sein Suchvektor werden dauerhaft entfernt und stehen nicht mehr für Antworten zur Verfügung.
      </p>
      <Notice>{error}</Notice>
      <div className="modal-actions">
        <button
          type="button"
          className="button secondary"
          onClick={onClose}
          disabled={busy}
        >
          Abbrechen
        </button>
        <button
          type="button"
          className="button danger"
          disabled={busy}
          onClick={remove}
        >
          {busy ? <Spinner /> : <Trash2 size={16} />}
          {busy ? 'Wird gelöscht …' : 'Abschnitt endgültig löschen'}
        </button>
      </div>
    </Modal>
  );
}

function RenameSourceModal({ source, onClose, onRenamed }) {
  const [title, setTitle] = useState(source.title || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) {
      setError('Bitte gib einen Namen für die Quelle ein.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await api(`/sources/${source.id}`, {
        method: 'PATCH',
        body: { title: trimmed },
      });
      onRenamed(res.source || { ...source, title: trimmed });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Quelle umbenennen"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form onSubmit={submit}>
        {source.type === 'url' && source.reference && (
          <div className="chunk-modal-source-info">
            <span className="source-label">Weblink:</span>{' '}
            <a
              href={source.reference}
              target="_blank"
              rel="noopener noreferrer"
              className="source-inline-link"
              title={`${source.reference} in neuem Tab öffnen`}
            >
              {source.reference} <ExternalLink size={12} />
            </a>
          </div>
        )}
        <label htmlFor="rename-source-title">Neuer Name der Quelle</label>
        <input
          id="rename-source-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Titel der Quelle eingeben …"
          maxLength={200}
          required
          autoFocus
          disabled={busy}
        />
        <Notice>{error}</Notice>
        <div className="modal-actions">
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={busy}
          >
            Abbrechen
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? <Spinner /> : <Pencil size={16} />}
            {busy ? 'Wird gespeichert …' : 'Speichern'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ImportSourcesModal({ onClose, onImported }) {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState('');
  const fileInput = useRef();

  function choose(f) {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith('.json')) {
      setError('Bitte wähle eine gültige Wissensraum-Exportdatei (.json) aus.');
      return;
    }
    setError('');
    setFile(f);
  }

  async function submit(e) {
    e.preventDefault();
    if (!file) {
      setError('Bitte wähle eine Datei zum Importieren aus.');
      return;
    }
    setBusy(true);
    setPercent(0);
    setError('');
    try {
      const res = await uploadImport(file, setPercent);
      onImported(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Quellen importieren"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form onSubmit={submit}>
        <p className="modal-lead">
          Lade eine JSON-Exportdatei aus einem anderen Wissensraum hoch. Die Quellen und ihre
          abgeleiteten Wissensartikel werden vollständig übertragen und einsatzbereit gemacht.
        </p>

        <div
          className={`dropzone ${file ? 'has-file' : ''}`}
          onClick={() => fileInput.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            choose(e.dataTransfer.files?.[0]);
          }}
        >
          <Upload size={32} />
          {file ? (
            <div>
              <strong>{file.name}</strong>
              <small>{(file.size / 1024).toFixed(1)} KB</small>
            </div>
          ) : (
            <div>
              <strong>Exportdatei (.json) hier ablegen</strong>
              <small>oder klicken zum Auswählen</small>
            </div>
          )}
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={(e) => choose(e.target.files?.[0])}
          />
        </div>

        {busy && (
          <div className="upload-progress">
            <progress max="100" value={percent} />
            <span>
              {percent < 100
                ? `Wird hochgeladen … ${percent}%`
                : 'Importiere und verarbeite Wissensartikel …'}
            </span>
          </div>
        )}

        <Notice>{error}</Notice>

        <div className="modal-actions">
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={busy}
          >
            Abbrechen
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={busy || !file}
          >
            {busy ? <Spinner /> : <Upload size={16} />}
            {busy ? 'Wird importiert …' : 'Import starten'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
