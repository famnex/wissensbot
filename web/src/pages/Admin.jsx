import React, { useState, useEffect, useCallback } from 'react';
import {
  KeyRound,
  Users,
  Download,
  ShieldCheck,
  RefreshCw,
  Layers,
  Check,
  Play,
  Search,
  Pause,
  ExternalLink,
} from 'lucide-react';
import { Notice, Spinner, Pagination } from '../components';
import { api } from '../api';
import { roles, date } from '../shared';
export function Admin({ user, overview, notify, refresh, onUserChange }) {
  const [tab, setTab] = useState('models');
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState('');
  const reload = useCallback(
    () =>
      api('/admin/settings')
        .then(setSettings)
        .catch((e) => setError(e.message)),
    [],
  );
  useEffect(() => {
    reload();
  }, [reload]);
  return (
    <div className="page-wrap admin-wrap">
      <div className="page-heading">
        <div>
          <span className="eyebrow">SYSTEM VERWALTEN</span>
          <h1>Administration</h1>
          <p>KI-Zugang, Berechtigungen und Betrieb an einem Ort.</p>
        </div>
        <span className="admin-role">
          <ShieldCheck size={17} /> Administrator
        </span>
      </div>
      <div className="tabs admin-tabs">
        {[
          ['models', KeyRound, 'KI & Modelle'],
          ['users', Users, 'Benutzer'],
          ['updates', Download, 'Wartung'],
        ].map(([key, Icon, label]) => (
          <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
            <Icon size={18} />
            {label}
          </button>
        ))}
      </div>
      <Notice>{error}</Notice>
      {!settings ? (
        <div className="empty-state">
          <Spinner /> Einstellungen laden …
        </div>
      ) : tab === 'models' ? (
        <Models
          settings={settings}
          reload={() => {
            reload();
            refresh();
          }}
          notify={notify}
        />
      ) : tab === 'users' ? (
        <UserManagement currentUser={user} notify={notify} onUserChange={onUserChange} />
      ) : (
        <Updates settings={settings} overview={overview} />
      )}
    </div>
  );
}

function Models({ settings, reload, notify }) {
  const [key, setKey] = useState('');
  const [models, setModels] = useState(null);
  const [chat, setChat] = useState(settings.chatModel?.name || '');
  const [embedding, setEmbedding] = useState(settings.embeddingModel);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const loadModels = useCallback(async () => {
    setBusy('list');
    setError('');
    try {
      setModels(await api('/admin/models'));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }, []);
  useEffect(() => {
    if (settings.hasKey) loadModels();
  }, [settings.hasKey, loadModels]);
  async function saveKey(event) {
    event.preventDefault();
    setBusy('key');
    setError('');
    try {
      const result = await api('/admin/key', { method: 'PUT', body: { apiKey: key } });
      setKey('');
      setModels(result.models);
      reload();
      notify('API-Schlüssel geprüft und verschlüsselt gespeichert.');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }
  async function saveModels(event) {
    event.preventDefault();
    setBusy('models');
    setError('');
    try {
      const result = await api('/admin/models', {
        method: 'PUT',
        body: { chatModel: chat, embeddingModel: embedding },
      });
      reload();
      notify(
        result.reindexed
          ? `Modelle gespeichert. ${result.reindexed} Quellen werden neu indexiert.`
          : 'Modelle gespeichert. Neue Antworten verwenden die Auswahl.',
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }
  async function test() {
    setBusy('test');
    setError('');
    try {
      await api('/admin/test', {
        method: 'POST',
        body: { chatModel: chat, embeddingModel: embedding },
      });
      notify('Verbindung erfolgreich: Textantwort und Embeddings funktionieren.');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }
  return (
    <>
      <Notice>{error}</Notice>
      <div className="admin-grid">
        <section className="panel settings-card">
          <div className="card-heading">
            <span className="card-icon">
              <KeyRound size={21} />
            </span>
            <div>
              <h2>Google Gemini</h2>
              <p>Der Zugang für Antworten und Wissenssuche.</p>
            </div>
            {settings.hasKey && (
              <span className="status ready">
                <Check size={13} /> Hinterlegt
              </span>
            )}
          </div>
          <form onSubmit={saveKey}>
            <label htmlFor="api-key">API-Schlüssel</label>
            <input
              id="api-key"
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={
                settings.hasKey
                  ? 'Gespeichert · neuen Schlüssel zum Ersetzen eingeben'
                  : 'Gemini API-Schlüssel eingeben'
              }
              required
              minLength={20}
              maxLength={300}
            />
            <p className="field-help">
              Der gespeicherte Schlüssel wird nie an den Browser zurückgegeben.
            </p>
            <button className="button primary" disabled={Boolean(busy) || !key.trim()}>
              {busy === 'key' ? <Spinner /> : <ShieldCheck size={17} />} Prüfen & speichern
            </button>
          </form>
        </section>
        <section className="panel settings-card">
          <div className="card-heading">
            <span className="card-icon">
              <Layers size={22} />
            </span>
            <div>
              <h2>Modelle auswählen</h2>
              <p>Aktuell verfügbare Modelle deines API-Zugangs.</p>
            </div>
            <button
              className="icon-button"
              aria-label="Modellliste aktualisieren"
              title="Modellliste aktualisieren"
              onClick={loadModels}
              disabled={Boolean(busy) || !settings.hasKey}
            >
              {busy === 'list' ? <Spinner /> : <RefreshCw size={17} />}
            </button>
          </div>
          <form onSubmit={saveModels}>
            <label htmlFor="chat-model">Chat-Modell</label>
            <select
              id="chat-model"
              value={chat}
              onChange={(e) => setChat(e.target.value)}
              required
              disabled={!models}
            >
              <option value="">Modell auswählen</option>
              {settings.chatModel &&
                !models?.chat.some((m) => m.name === settings.chatModel.name) && (
                  <option value={settings.chatModel.name} disabled>
                    {settings.chatModel.displayName} · Verfügbarkeit prüfen
                  </option>
                )}
              {models?.chat.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.displayName}
                </option>
              ))}
            </select>
            <p className="field-help">
              Textfähige Chat-Modelle; reine Bild-, Audio- und Embedding-Modelle sind
              ausgeschlossen.
            </p>
            <label htmlFor="embedding-model">Embedding-Modell</label>
            <select
              id="embedding-model"
              value={embedding}
              onChange={(e) => setEmbedding(e.target.value)}
              required
              disabled={!models}
            >
              {!models?.embedding.some((m) => m.name === embedding) && (
                <option value={embedding} disabled>
                  {embedding} · Verfügbarkeit prüfen
                </option>
              )}
              {models?.embedding.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.displayName}
                </option>
              ))}
            </select>
            {embedding !== settings.embeddingModel && (
              <Notice kind="info">
                Ein Wechsel indexiert alle lesbaren Quellen neu. Währenddessen steht das betroffene
                Wissen noch nicht für Antworten bereit.
              </Notice>
            )}
            <div className="button-row">
              <button className="button primary" disabled={Boolean(busy) || !models || !chat}>
                {busy === 'models' ? <Spinner /> : <Check size={17} />} Auswahl speichern
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={Boolean(busy) || !models || !chat}
                onClick={test}
              >
                {busy === 'test' ? <Spinner /> : <Play size={15} />} Funktion testen
              </button>
            </div>
            <p className="field-help">
              Der Funktionstest ruft eine kurze Antwort und ein Embedding ab und kann API-Kosten
              verursachen.
            </p>
          </form>
        </section>
      </div>
      <section className="panel auth-card">
        <div>
          <ShieldCheck size={22} />
          <h2>Identität & Anmeldung</h2>
        </div>
        <dl>
          <dt>Signaturprüfung</dt>
          <dd>
            {settings.auth.mode} · {settings.auth.algorithm}
          </dd>
          <dt>Aussteller</dt>
          <dd>{settings.auth.issuer}</dd>
          <dt>Zielgruppe</dt>
          <dd>{settings.auth.audience}</dd>
        </dl>
        <p>
          Vertrauenswürdige Schlüssel werden über die Server-Konfiguration verwaltet. Berechtigungen
          stammen ausschließlich aus der lokalen Benutzerverwaltung.
        </p>
      </section>
    </>
  );
}

function UserManagement({ currentUser, notify, onUserChange }) {
  const [users, setUsers] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const reload = useCallback(
    () =>
      api(`/admin/users?page=${page}&q=${encodeURIComponent(query)}`)
        .then((data) => {
          setUsers(data.users);
          setTotal(data.total);
        })
        .catch((e) => setError(e.message)),
    [page, query],
  );
  useEffect(() => {
    const t = setTimeout(reload, 200);
    return () => clearTimeout(t);
  }, [reload]);
  async function update(user, values) {
    setBusy(user.id);
    setError('');
    try {
      await api(`/admin/users/${user.id}`, {
        method: 'PATCH',
        body: { role: user.role, enabled: Boolean(user.enabled), ...values },
      });
      await reload();
      notify('Berechtigungen aktualisiert.');
      if (user.id === currentUser.id) await onUserChange();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }
  return (
    <>
      <Notice>{error}</Notice>
      <section className="panel">
        <div className="panel-toolbar">
          <h2>
            Benutzer <span className="count-pill">{total}</span>
          </h2>
          <div className="search-box">
            <Search size={17} />
            <input
              aria-label="Benutzer suchen"
              placeholder="Name oder E-Mail …"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
          </div>
        </div>
        <div className="user-list">
          {users.map((user) => (
            <div className="user-row" key={user.id}>
              <div className="user-identity">
                <div className="avatar light">{user.name.slice(0, 1)}</div>
                <div>
                  <strong>
                    {user.name}
                    {user.id === currentUser.id && <span className="you-label">Du</span>}
                  </strong>
                  <small>{user.email}</small>
                </div>
              </div>
              <select
                aria-label={`Rolle von ${user.name}`}
                value={user.role}
                onChange={(e) => update(user, { role: e.target.value })}
                disabled={busy === user.id}
              >
                {Object.entries(roles).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <button
                className={`status user-switch ${user.enabled ? 'ready' : 'paused'}`}
                disabled={busy === user.id}
                onClick={() => update(user, { enabled: !user.enabled })}
                aria-label={`${user.name} ${user.enabled ? 'deaktivieren' : 'aktivieren'}`}
                aria-pressed={Boolean(user.enabled)}
              >
                {busy === user.id ? (
                  <Spinner />
                ) : user.enabled ? (
                  <Check size={14} />
                ) : (
                  <Pause size={14} />
                )}{' '}
                {user.enabled ? 'Aktiv' : 'Gesperrt'}
              </button>
            </div>
          ))}
        </div>
        {!users.length && (
          <div className="empty-state">
            <Users size={28} />
            <p>Keine Benutzer gefunden.</p>
          </div>
        )}
        {total > 50 && <Pagination total={total} page={page} pageSize={50} onChange={setPage} />}
      </section>
      <div className="role-guide">
        {[
          ['user', 'Mit dem Wissenschat arbeiten.'],
          ['editor', 'Zusätzlich Wissen hinzufügen und verwalten.'],
          ['admin', 'Zusätzlich Modelle, Benutzer und Updates verwalten.'],
        ].map(([role, description]) => (
          <div key={role}>
            <strong>{roles[role]}</strong>
            <p>{description}</p>
          </div>
        ))}
      </div>
      <p className="page-footnote">
        <ShieldCheck size={15} /> Neue Benutzer erscheinen nach ihrer ersten Anmeldung. Der letzte
        aktive Administrator kann nicht herabgestuft oder gesperrt werden.
      </p>
    </>
  );
}

function Updates({ settings, overview }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [offline, setOffline] = useState(false);
  const [starting, setStarting] = useState(false);
  const reload = useCallback(async () => {
    try {
      setStatus(await api('/admin/updates'));
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, 2500);
    return () => clearInterval(timer);
  }, [reload]);
  const active =
    status &&
    [
      'preparing',
      'backup',
      'pulling',
      'installing',
      'building',
      'migrating',
      'restarting',
      'rolling_back',
    ].includes(status.state);
  async function start() {
    setError('');
    setStarting(true);
    try {
      await api('/admin/updates', { method: 'POST' });
      setStatus({ ...status, state: 'preparing', message: 'Update wurde angefordert.' });
      await reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setStarting(false);
    }
  }
  const steps = ['Prüfung', 'Backup', 'Installation', 'Migration', 'Neustart'];
  const stage =
    {
      preparing: 0,
      backup: 1,
      pulling: 2,
      installing: 2,
      building: 2,
      migrating: 3,
      restarting: 4,
      succeeded: 5,
    }[status?.state] ?? -1;
  return (
    <>
      <Notice>{error}</Notice>
      <Notice kind="info">
        {offline &&
          'Die Anwendung startet möglicherweise gerade neu. Der Update-Prozess läuft unabhängig weiter. Die Verbindung wird automatisch erneut geprüft.'}
      </Notice>
      <section className="panel settings-card update-card">
        <div className="card-heading">
          <span className="card-icon">
            <Download size={22} />
          </span>
          <div>
            <h2>System aktualisieren</h2>
            <p>Den aktuellen Stand aus dem konfigurierten Repository übernehmen.</p>
          </div>
        </div>
        <dl className="update-details">
          <dt>Repository</dt>
          <dd>
            {settings.updateRepository ? (
              <a href={settings.updateRepository} target="_blank" rel="noopener noreferrer">
                {settings.updateRepository.replace('https://github.com/', '').replace(/\.git$/, '')}{' '}
                <ExternalLink size={14} />
              </a>
            ) : (
              'Noch nicht konfiguriert'
            )}
          </dd>
          <dt>Branch</dt>
          <dd>
            <code>{settings.updateBranch}</code>
          </dd>
          <dt>Indexierung</dt>
          <dd>{overview?.workerOnline ? 'Bereit' : 'Nicht erreichbar'}</dd>
          <dt>Update-Dienst</dt>
          <dd>{status?.daemonOnline ? 'Bereit' : 'Nicht erreichbar'}</dd>
        </dl>
        <div className="update-explainer">
          <ShieldCheck size={23} />
          <p>
            Vor dem Update werden Datenbank, Abhängigkeiten und Oberfläche gesichert. Bei einem
            Fehler wird der vorherige Stand wiederhergestellt. Während des Updates ist die Anwendung
            kurz nicht verfügbar.
          </p>
        </div>
        {!settings.updatesEnabled && (
          <Notice kind="info">
            Die Update-Funktion ist auf dem Server noch deaktiviert. Die README beschreibt die
            Einrichtung des Repositorys und des PM2-Update-Dienstes.
          </Notice>
        )}
        <button
          className="button primary"
          onClick={start}
          disabled={
            !settings.updatesEnabled || !status?.daemonOnline || active || starting || offline
          }
        >
          {active || starting ? <Spinner /> : <Download size={17} />}{' '}
          {active ? 'Update läuft …' : starting ? 'Update anfordern …' : 'Update starten'}
        </button>
        {status && status.state !== 'idle' && (
          <div className="update-state">
            <div className="update-steps">
              {steps.map((step, i) => (
                <div key={step} className={i < stage ? 'done' : i === stage ? 'current' : ''}>
                  <span>{i < stage ? <Check size={14} /> : i + 1}</span>
                  {step}
                </div>
              ))}
            </div>
            <Notice
              kind={
                ['failed', 'rollback_failed'].includes(status.state)
                  ? 'error'
                  : ['succeeded', 'no_change'].includes(status.state)
                    ? 'success'
                    : 'info'
              }
            >
              {status.message}
            </Notice>
            {status.updatedAt && <small>Letzte Änderung: {date(status.updatedAt)}</small>}
          </div>
        )}
      </section>
    </>
  );
}
