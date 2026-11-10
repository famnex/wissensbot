import React, { useState, useEffect, useCallback } from 'react';
import {
  Inbox as InboxIcon,
  Search,
  CheckCircle2,
  XCircle,
  Trash2,
  Plus,
  RefreshCw,
  Clock,
  User,
  MessageSquare,
  HelpCircle,
  FilePlus,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { Notice, Spinner, Modal, Stat, Pagination } from '../components';
import { api } from '../api';
import { date } from '../shared';

export function InboxView({ user, overview, notify, refresh, onAddKnowledge }) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [openCount, setOpenCount] = useState(0);
  const [resolvedCount, setResolvedCount] = useState(0);
  const [dismissedCount, setDismissedCount] = useState(0);
  const [statusFilter, setStatusFilter] = useState('open');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [noteItem, setNoteItem] = useState(null);
  const [deleteItem, setDeleteItem] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api(
        `/inbox?status=${statusFilter}&q=${encodeURIComponent(query)}&page=${page}&pageSize=20`,
      );
      setItems(data.items);
      setTotal(data.total);
      setOpenCount(data.openCount);
      setResolvedCount(data.resolvedCount);
      setDismissedCount(data.dismissedCount);
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, query, page]);

  useEffect(() => {
    setLoading(true);
    const t = setTimeout(load, 200);
    const poll = setInterval(load, 5000);
    return () => {
      clearTimeout(t);
      clearInterval(poll);
    };
  }, [load]);

  async function updateStatus(item, newStatus) {
    setBusyId(item.id);
    try {
      await api(`/inbox/${item.id}`, {
        method: 'PATCH',
        body: { status: newStatus },
      });
      await load();
      refresh();
      notify(
        newStatus === 'resolved'
          ? 'Frage als erledigt markiert.'
          : newStatus === 'dismissed'
            ? 'Frage verworfen.'
            : 'Frage wieder als offen markiert.',
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId('');
    }
  }

  async function removeItem(id) {
    setBusyId(id);
    try {
      await api(`/inbox/${id}`, { method: 'DELETE' });
      setDeleteItem(null);
      await load();
      refresh();
      notify('Eintrag gelöscht.');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId('');
    }
  }

  return (
    <div className="page-wrap">
      <div className="page-heading">
        <div>
          <span className="eyebrow">WISSENSLÜCKEN & BEDARFE</span>
          <h1>Wissens-Inbox</h1>
          <p>
            Fragen aus dem Chat, zu denen noch keine passende Antwort in der Wissensbasis vorliegt.
          </p>
        </div>
        <button
          type="button"
          className="button secondary"
          onClick={() => {
            setLoading(true);
            load();
          }}
          title="Inbox aktualisieren"
        >
          <RefreshCw size={16} className={loading ? 'spin' : ''} /> Aktualisieren
        </button>
      </div>

      <div className="stats-grid">
        <Stat
          label="Offene Wissenslücken"
          value={openCount}
          icon={HelpCircle}
        />
        <Stat
          label="Nachgepflegt & Erledigt"
          value={resolvedCount}
          icon={CheckCircle2}
        />
        <Stat
          label="Verworfen / Nicht relevant"
          value={dismissedCount}
          icon={XCircle}
        />
      </div>

      <Notice>{error}</Notice>

      <section className="panel">
        <div className="panel-toolbar">
          <div className="tabs" role="tablist">
            {[
              ['open', `Offen (${openCount})`],
              ['resolved', `Erledigt (${resolvedCount})`],
              ['dismissed', `Verworfen (${dismissedCount})`],
              ['all', `Alle (${openCount + resolvedCount + dismissedCount})`],
            ].map(([val, label]) => (
              <button
                key={val}
                type="button"
                className={statusFilter === val ? 'active' : ''}
                onClick={() => {
                  setStatusFilter(val);
                  setPage(1);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="search-box">
            <Search size={17} />
            <input
              placeholder="In Fragen suchen …"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
          </div>
        </div>

        {loading && items.length === 0 ? (
          <div className="empty-state">
            <Spinner /> Inbox wird geladen …
          </div>
        ) : items.length === 0 ? (
          <div className="empty-state">
            <InboxIcon size={34} />
            <h3>
              {statusFilter === 'open'
                ? 'Keine offenen Wissenslücken'
                : 'Keine Einträge gefunden'}
            </h3>
            <p>
              {statusFilter === 'open'
                ? 'Großartig! Zu allen bisher gestellten Fragen liegt passendes Wissen vor oder offene Fragen wurden bereits nachgepflegt.'
                : 'In diesem Filter liegen derzeit keine Fragen vor.'}
            </p>
          </div>
        ) : (
          <div className="inbox-list">
            {items.map((item) => {
              const isBusy = busyId === item.id;
              const isExpanded = expandedId === item.id;
              return (
                <article
                  key={item.id}
                  className={`inbox-card status-${item.status}`}
                >
                  <div className="inbox-card-main">
                    <div className="inbox-question-row">
                      <span className={`status-pill status-${item.status}`}>
                        {item.status === 'open'
                          ? 'Offen'
                          : item.status === 'resolved'
                            ? 'Erledigt'
                            : 'Verworfen'}
                      </span>
                      {item.count > 1 && (
                        <span
                          className="inbox-count-badge"
                          title={`Diese Frage wurde ${item.count} Mal gestellt.`}
                        >
                          🔥 {item.count}x gefragt
                        </span>
                      )}
                      <div className="inbox-meta-info">
                        {item.asked_by_name && (
                          <span className="inbox-user">
                            <User size={13} /> {item.asked_by_name}
                          </span>
                        )}
                        <span className="inbox-date">
                          <Clock size={13} /> {date(item.updated_at || item.created_at)}
                        </span>
                      </div>
                    </div>

                    <h3 className="inbox-question-text">{item.question}</h3>

                    {item.note && (
                      <div className="inbox-note-banner">
                        <strong>Notiz:</strong> {item.note}
                      </div>
                    )}

                    {item.answer && (
                      <div className="inbox-answer-preview">
                        <button
                          type="button"
                          className="inbox-toggle-answer"
                          onClick={() => setExpandedId(isExpanded ? null : item.id)}
                        >
                          <MessageSquare size={14} />
                          <span>{isExpanded ? 'Antwort-Vorschau ausblenden' : 'Bisherige KI-Antwort anzeigen'}</span>
                          {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        </button>
                        {isExpanded && (
                          <div className="inbox-answer-body">
                            <p>{item.answer}</p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="inbox-card-actions">
                    {isBusy ? (
                      <Spinner />
                    ) : (
                      <>
                        <button
                          type="button"
                          className="button primary small"
                          title="Neues Wissen zu dieser Frage anlegen"
                          onClick={() => {
                            if (onAddKnowledge) {
                              onAddKnowledge(
                                `Thema: ${item.question}\n\nInformationen:\n`,
                                item.question.slice(0, 80),
                              );
                            }
                          }}
                        >
                          <FilePlus size={14} /> Wissen anlegen
                        </button>

                        {item.status !== 'resolved' ? (
                          <button
                            type="button"
                            className="button secondary small"
                            title="Als erledigt markieren"
                            onClick={() => updateStatus(item, 'resolved')}
                          >
                            <CheckCircle2 size={14} /> Erledigt
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="button secondary small"
                            title="Wieder öffnen"
                            onClick={() => updateStatus(item, 'open')}
                          >
                            <HelpCircle size={14} /> Wieder öffnen
                          </button>
                        )}

                        {item.status !== 'dismissed' && (
                          <button
                            type="button"
                            className="icon-button"
                            title="Frage verwerfen"
                            onClick={() => updateStatus(item, 'dismissed')}
                          >
                            <XCircle size={16} />
                          </button>
                        )}

                        <button
                          type="button"
                          className="icon-button"
                          title="Notiz hinzufügen"
                          onClick={() => setNoteItem(item)}
                        >
                          Notiz
                        </button>

                        <button
                          type="button"
                          className="icon-button danger-icon"
                          title="Eintrag löschen"
                          onClick={() => setDeleteItem(item)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {total > 20 && (
          <Pagination
            page={page}
            pageSize={20}
            total={total}
            onChange={setPage}
          />
        )}
      </section>

      {noteItem && (
        <InboxNoteModal
          item={noteItem}
          onClose={() => setNoteItem(null)}
          onSaved={async (note) => {
            try {
              await api(`/inbox/${noteItem.id}`, {
                method: 'PATCH',
                body: { note },
              });
              setNoteItem(null);
              await load();
              notify('Notiz gespeichert.');
            } catch (e) {
              setError(e.message);
            }
          }}
        />
      )}

      {deleteItem && (
        <Modal
          title="Inbox-Eintrag löschen?"
          onClose={() => setDeleteItem(null)}
        >
          <p>
            Möchtest du die Frage <strong>„{deleteItem.question}“</strong> wirklich dauerhaft aus der Inbox löschen?
          </p>
          <div className="modal-actions">
            <button
              type="button"
              className="button secondary"
              onClick={() => setDeleteItem(null)}
            >
              Abbrechen
            </button>
            <button
              type="button"
              className="button danger"
              onClick={() => removeItem(deleteItem.id)}
            >
              <Trash2 size={16} /> Endgültig löschen
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function InboxNoteModal({ item, onClose, onSaved }) {
  const [note, setNote] = useState(item.note || '');
  const [busy, setBusy] = useState(false);

  function submit(e) {
    e.preventDefault();
    setBusy(true);
    onSaved(note);
  }

  return (
    <Modal title="Notiz zur Wissenslücke" onClose={onClose}>
      <form onSubmit={submit}>
        <p className="modal-lead">
          Frage: <strong>{item.question}</strong>
        </p>
        <label htmlFor="inbox-note-text">Interne Notiz / Bearbeitungsstand</label>
        <textarea
          id="inbox-note-text"
          rows={4}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="z. B. Herr Müller liefert bis Freitag das Dokument zur Richtlinie."
          maxLength={1000}
          autoFocus
          disabled={busy}
        />
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
            {busy ? <Spinner /> : 'Speichern'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
