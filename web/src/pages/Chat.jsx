import React, { useState, useRef, useEffect } from 'react';
import {
  Layers,
  ArrowRight,
  BookOpen,
  Search,
  Plus,
  Paperclip,
  Square,
  ArrowUp,
  ShieldCheck,
} from 'lucide-react';
import { Notice, Spinner, Message } from '../components';
import { streamChat } from '../api';
import { chatKey } from '../shared';
export function Chat({ user, overview, notify, onKnowledge, onAdmin, refresh }) {
  const [messages, setMessages] = useState(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(chatKey(user.id)) || '[]');
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  });
  const [draft, setDraft] = useState('');
  const [learn, setLearn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState('');
  const [stream, setStream] = useState('');
  const [streamSources, setStreamSources] = useState([]);
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState(false);
  const bottom = useRef();
  const input = useRef();
  const controller = useRef();
  useEffect(() => {
    try {
      sessionStorage.setItem(chatKey(user.id), JSON.stringify(messages));
    } catch {
      setStorageError(true);
    }
  }, [messages, user.id]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: busy ? 'auto' : 'smooth', block: 'end' });
  }, [messages, stream, pending, busy]);
  useEffect(() => () => controller.current?.abort(), []);
  async function send(event) {
    event.preventDefault();
    const question = draft.trim();
    if (!question || busy) return;
    setError('');
    setBusy(true);
    setDraft('');
    setPending(question);
    setStream('');
    setStreamSources([]);
    controller.current = new AbortController();
    let text = '';
    let sources = [];
    let learned = false;
    let warning = '';
    let inboxRecorded = false;
    const sent = learn ? `!learn ${question}` : question;
    try {
      await streamChat(
        [...messages, { role: 'user', text: sent }],
        (event) => {
          if (event.type === 'delta') {
            text += event.text;
            setStream(text.replace(/\[(WISSENSLUECKE|UNBEANTWORTET)\]/gi, '').trimEnd());
          }
          if (event.type === 'sources') {
            sources = event.sources;
            setStreamSources(sources);
          }
          if (event.type === 'inbox_recorded') inboxRecorded = true;
          if (event.type === 'learned') learned = true;
          if (event.type === 'warning') warning = event.message;
        },
        controller.current.signal,
      );
      if (learned) {
        notify('Wissen hinzugefügt. Die Indexierung läuft im Hintergrund.');
        refresh();
      } else {
        const cleanText = text.replace(/\[(WISSENSLUECKE|UNBEANTWORTET)\]/gi, '').trim();
        if (inboxRecorded) refresh();
        setMessages([
          ...messages,
          { role: 'user', text: question },
          { role: 'model', text: cleanText, sources, warning, inboxRecorded },
        ]);
      }
    } catch (e) {
      setError(
        e.name === 'AbortError'
          ? 'Antwort abgebrochen. Du kannst deine Frage erneut senden.'
          : e.message,
      );
      setDraft(question);
    } finally {
      setBusy(false);
      setPending('');
      setStream('');
      setStreamSources([]);
      input.current?.focus();
    }
  }
  const canWrite = user.role !== 'user';
  return (
    <>
      <div className="chat-meta">
        <span className="model-tag">
          <span className="model-glyph">
            <Layers size={14} />
          </span>
          {overview?.model || 'Modell noch nicht eingerichtet'}
        </span>
        <span>{overview?.readyArticles ?? overview?.ready ?? 0} Artikel verfügbar</span>
      </div>
      {overview && !overview.configured && (
        <div className="chat-setup">
          <Notice kind="info">
            Der KI-Zugang ist noch nicht vollständig eingerichtet.{' '}
            {user.role === 'admin' ? (
              <button className="text-button" onClick={onAdmin}>
                Jetzt einrichten <ArrowRight size={14} />
              </button>
            ) : (
              'Bitte wende dich an einen Administrator.'
            )}
          </Notice>
        </div>
      )}
      <div className="chat-scroll">
        {messages.length === 0 && !pending ? (
          <div className="chat-empty">
            <div className="empty-symbol">
              <Layers size={34} />
            </div>
            <span className="eyebrow">DEIN WISSEN, GUT VERBUNDEN</span>
            <h1>Was möchtest du wissen?</h1>
            <p>
              Stelle eine Frage zu eurem Wissen.
              <br />
              Du erhältst eine Antwort mit belegten Wissensartikeln und Quellen.
            </p>
            <div className="prompt-grid">
              {[
                {
                  icon: Search,
                  title: 'Informationen finden',
                  prompt: 'Welche Informationen gibt es zu ',
                },
                {
                  icon: BookOpen,
                  title: 'Ein Thema verstehen',
                  prompt: 'Erkläre mir anhand der Quellen ',
                },
                {
                  icon: Layers,
                  title: 'Wissen zusammenfassen',
                  prompt: 'Fasse das vorhandene Wissen zu folgendem Thema zusammen: ',
                },
              ].map(({ icon: Icon, title, prompt }) => (
                <button
                  key={title}
                  onClick={() => {
                    setDraft(prompt);
                    input.current?.focus();
                  }}
                >
                  <Icon size={20} />
                  <span>{title}</span>
                  <ArrowRight size={16} />
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="conversation">
            {messages.map((message, i) => (
              <Message key={i} message={message} user={user} notify={notify} />
            ))}
            {pending && (
              <Message message={{ role: 'user', text: pending }} user={user} notify={notify} />
            )}{' '}
            {busy && (
              <Message
                message={{ role: 'model', text: stream, sources: streamSources }}
                user={user}
                streaming
                notify={notify}
              />
            )}
            <div ref={bottom} />
          </div>
        )}
      </div>
      <div className="composer-wrap">
        <Notice>{error}</Notice>
        <Notice kind="info">
          {storageError &&
            'Der Browser kann den Verlauf nicht zwischenspeichern. Er bleibt bis zum Neuladen dieser Seite verfügbar.'}
        </Notice>
        <form className={`composer ${learn ? 'learn-mode' : ''}`} onSubmit={send}>
          {learn && (
            <div className="learn-banner">
              <BookOpen size={16} /> Dieser Text wird als neue Wissensquelle gespeichert.
            </div>
          )}
          <textarea
            ref={input}
            aria-label={learn ? 'Wissen eingeben' : 'Deine Frage'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send(e);
              }
            }}
            placeholder={
              learn ? 'Welches Wissen möchtest du festhalten?' : 'Frage etwas zu eurem Wissen …'
            }
            maxLength={32000}
            rows={2}
            disabled={busy}
          />
          <div className="composer-tools">
            <div>
              {canWrite && (
                <>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={onKnowledge}
                    aria-label="Datei als Wissen hinzufügen"
                    title="Datei als Wissen hinzufügen"
                  >
                    <Paperclip size={19} />
                  </button>
                  <button
                    type="button"
                    className={`learn-toggle ${learn ? 'selected' : ''}`}
                    onClick={() => setLearn(!learn)}
                    aria-pressed={learn}
                    disabled={busy}
                  >
                    <Plus size={16} />
                    {learn ? 'Wissenseingabe aktiv' : 'Wissen hinzufügen'}
                  </button>
                </>
              )}
            </div>
            <div>
              <small className="enter-hint">Enter zum Senden</small>
              {busy ? (
                <button
                  type="button"
                  className="send-button"
                  onClick={() => controller.current?.abort()}
                  aria-label="Antwort abbrechen"
                >
                  <Square size={17} />
                </button>
              ) : (
                <button
                  className="send-button"
                  disabled={!draft.trim() || (!learn && overview && !overview.configured)}
                  aria-label={learn ? 'Wissen speichern' : 'Frage senden'}
                >
                  <ArrowUp size={20} />
                </button>
              )}
            </div>
          </div>
        </form>
        <p className="composer-note">
          <ShieldCheck size={13} /> Der Chat bleibt in dieser Browser-Sitzung. Fragen und passende
          Wissensauszüge werden zur Beantwortung an Gemini gesendet.
        </p>
      </div>
    </>
  );
}
