import React, { useEffect, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import {
  MessageSquare,
  Database,
  Settings,
  Plus,
  LogOut,
  ShieldCheck,
  ChevronRight,
  BookOpen,
  X,
  CheckCircle2,
  Inbox,
} from 'lucide-react';
import { api } from './api';
import { roles, chatKey } from './shared';
import { Brand, Modal, Notice, Spinner } from './components';
import { Login } from './pages/Login';
import { Chat } from './pages/Chat';
import { Knowledge } from './pages/Knowledge';
import { Admin } from './pages/Admin';
import { InboxView } from './pages/Inbox';
import './styles.css';
function App() {
  const [bootstrap, setBootstrap] = useState(null);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState('');
  const [view, setView] = useState('chat');
  const [overview, setOverview] = useState(null);
  const [toast, setToast] = useState('');
  const [version, setVersion] = useState(0);
  const [reset, setReset] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [initialKnowledge, setInitialKnowledge] = useState(null);
  const notify = useCallback((message) => setToast(message), []);
  const refresh = useCallback(
    () =>
      api('/overview')
        .then(setOverview)
        .catch(() => {}),
    [],
  );
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const boot = await api('/bootstrap');
        if (live) setBootstrap(boot);
        let data;
        const token = window.__initialAccessToken;
        delete window.__initialAccessToken;
        if (token) data = await api('/auth/exchange', { method: 'POST', token });
        else data = await api('/me');
        if (live) setUser(data.user);
      } catch (e) {
        if (live && !['LOGIN_REQUIRED', 'INVALID_TOKEN', 'USER_DISABLED'].includes(e.code))
          setFatal(e.message);
      } finally {
        if (live) setLoading(false);
      }
    })();
    const expired = () => {
      setUser(null);
      setView('chat');
    };
    window.addEventListener('session-expired', expired);
    return () => {
      live = false;
      window.removeEventListener('session-expired', expired);
    };
  }, []);
  useEffect(() => {
    if (!user) return;
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => clearInterval(timer);
  }, [user, refresh]);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(''), 6000);
      return () => clearTimeout(t);
    }
  }, [toast]);
  useEffect(() => {
    if (
      user &&
      ((view === 'admin' && user.role !== 'admin') ||
        (view === 'knowledge' && user.role === 'user'))
    )
      setView('chat');
  }, [user, view]);
  async function logout() {
    try {
      const res = await api('/auth/logout', { method: 'POST' });
      try {
        sessionStorage.removeItem(chatKey(user.id));
      } catch {}
      const target = res?.redirectUrl || bootstrap?.loginUrl;
      if (target) {
        window.location.href = target;
        return;
      }
      setUser(null);
      setOverview(null);
      setView('chat');
    } catch (e) {
      notify(e.message);
    }
  }
  function clearChat() {
    try {
      sessionStorage.removeItem(chatKey(user.id));
    } catch {}
    setVersion((v) => v + 1);
    setReset(false);
    setView('chat');
  }
  if (loading)
    return (
      <div className="boot">
        <Brand />
        <Spinner />
        <p>Wissensraum wird geöffnet …</p>
      </div>
    );
  if (!user)
    return (
      <>
        <Login
          bootstrap={bootstrap}
          onLogin={(data) => {
            setUser(data.user);
            setFatal('');
          }}
        />
        {fatal && (
          <div className="connection-note">
            <Notice>{fatal}</Notice>
          </div>
        )}
      </>
    );
  const canWrite = user.role !== 'user';
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <button className="new-chat" onClick={() => setReset(true)}>
          <Plus size={18} /> Neues Gespräch
        </button>
        <span className="nav-caption">ARBEITSBEREICH</span>
        <nav aria-label="Hauptnavigation">
          <button className={view === 'chat' ? 'active' : ''} onClick={() => setView('chat')}>
            <MessageSquare size={19} /> Wissenschat
          </button>
          {canWrite && (
            <button
              className={view === 'knowledge' ? 'active' : ''}
              onClick={() => setView('knowledge')}
            >
              <Database size={19} /> Wissensbasis{' '}
              <span className="nav-count" title="Verfügbare Wissensartikel">
                {overview?.totalArticles ?? overview?.total ?? '–'}
              </span>
            </button>
          )}
          {canWrite && (
            <button
              className={view === 'inbox' ? 'active' : ''}
              onClick={() => setView('inbox')}
            >
              <Inbox size={19} /> Wissens-Inbox{' '}
              <span
                className={`nav-count ${overview?.inboxOpen > 0 ? 'nav-count-alert' : ''}`}
                title="Offene Wissenslücken"
              >
                {overview?.inboxOpen ?? 0}
              </span>
            </button>
          )}
          {user.role === 'admin' && (
            <button className={view === 'admin' ? 'active' : ''} onClick={() => setView('admin')}>
              <Settings size={19} /> Administration
            </button>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="knowledge-mini">
            <span className="mini-icon">
              <BookOpen size={19} />
            </span>
            <div>
              <strong>{overview?.readyArticles ?? overview?.ready ?? '–'} Artikel verfügbar</strong>
              <small>Wissen für deine Antworten</small>
            </div>
          </div>
          <div className="profile">
            <div className="avatar">{user.name.slice(0, 1).toUpperCase()}</div>
            <div>
              <strong>{user.name}</strong>
              <small>{roles[user.role]}</small>
            </div>
            <button onClick={logout} className="logout" aria-label="Abmelden" title="Abmelden">
              <LogOut size={18} />
            </button>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div>
            <span className="breadcrumb">Arbeitsbereich</span>
            <ChevronRight size={15} />
            <strong>
              {
                {
                  chat: 'Wissenschat',
                  knowledge: 'Wissensbasis',
                  inbox: 'Wissens-Inbox',
                  admin: 'Administration',
                }[view]
              }
            </strong>
          </div>
          <div className="topbar-actions">
            {view === 'chat' && (
              <span className="session-label">
                <ShieldCheck size={16} /> Nur diese Sitzung
              </span>
            )}
            <button
              className="button secondary mobile-new-chat"
              onClick={() => setReset(true)}
              aria-label="Neues Gespräch"
              title="Neues Gespräch"
            >
              <Plus size={18} />
            </button>
          </div>
        </header>
        <main className={`main-content ${view === 'chat' ? 'chat-page' : ''}`}>
          {view === 'chat' && (
            <Chat
              key={`${user.id}:${version}`}
              user={user}
              overview={overview}
              notify={notify}
              onKnowledge={() => {
                setUploadOpen(true);
                setView('knowledge');
              }}
              onAdmin={() => setView('admin')}
              refresh={refresh}
            />
          )}{' '}
          {view === 'knowledge' && canWrite && (
            <Knowledge
              overview={overview}
              notify={notify}
              refresh={refresh}
              initialOpen={uploadOpen}
              initialData={initialKnowledge}
              onOpened={() => {
                setUploadOpen(false);
                setInitialKnowledge(null);
              }}
            />
          )}{' '}
          {view === 'inbox' && canWrite && (
            <InboxView
              user={user}
              overview={overview}
              notify={notify}
              refresh={refresh}
              onAddKnowledge={(text, title) => {
                setInitialKnowledge({ text, title });
                setUploadOpen(true);
                setView('knowledge');
              }}
            />
          )}{' '}
          {view === 'admin' && user.role === 'admin' && (
            <Admin
              user={user}
              overview={overview}
              notify={notify}
              refresh={refresh}
              onUserChange={() => api('/me').then((data) => setUser(data.user))}
            />
          )}
        </main>
      </div>
      {reset && (
        <Modal title="Neues Gespräch beginnen?" onClose={() => setReset(false)}>
          <p>Der bisherige Gesprächskontext dieser Browser-Sitzung wird entfernt.</p>
          <div className="modal-actions">
            <button className="button secondary" onClick={() => setReset(false)}>
              Abbrechen
            </button>
            <button className="button primary" onClick={clearChat}>
              Neues Gespräch
            </button>
          </div>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={18} />
          <span>{toast}</span>
          <button onClick={() => setToast('')} aria-label="Meldung schließen">
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
// Accept IdP hand-off in URL search query or fragment hash; strip it immediately before any network request.
const hashParams = new URLSearchParams(location.hash.slice(1));
const searchParams = new URLSearchParams(location.search);
const tokenKey = ['sso_token', 'access_token', 'token', 'jwt'].find(
  (k) => hashParams.has(k) || searchParams.has(k),
);
if (tokenKey) {
  window.__initialAccessToken = hashParams.get(tokenKey) || searchParams.get(tokenKey);
  hashParams.delete(tokenKey);
  searchParams.delete(tokenKey);
  const cleanSearch = searchParams.toString() ? `?${searchParams.toString()}` : '';
  const cleanHash = hashParams.toString() ? `#${hashParams.toString()}` : '';
  history.replaceState(null, '', location.pathname + cleanSearch + cleanHash);
}
createRoot(document.getElementById('root')).render(<App />);
