import React, { useState } from 'react';
import { KeyRound, ArrowRight, ShieldCheck, BookOpen } from 'lucide-react';
import { Brand, Notice, Spinner } from '../components';
import { api } from '../api';
export function Login({ bootstrap, onLogin }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showManualToken, setShowManualToken] = useState(false);
  const loginUrl = bootstrap?.loginUrl || 'https://cloud.mso-hef.de/novus/api/tiles/sso/';

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = await api('/auth/exchange', { method: 'POST', token: token.trim() });
      setToken('');
      onLogin(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-layout">
      <aside className="login-aside">
        <Brand />
        <div>
          <span className="eyebrow">DEIN ORGANISATIONSWISSEN</span>
          <h1>
            Aus Informationen
            <br />
            werden Antworten.
          </h1>
          <p>Ein gemeinsamer Ort für Dokumente, Erfahrungen und das Wissen deines Teams.</p>
          <div className="login-benefit">
            <BookOpen />
            <span>Antworten mit nachvollziehbaren Quellen</span>
          </div>
          <div className="login-benefit">
            <ShieldCheck />
            <span>Persönlicher Zugang. Klare Rollen.</span>
          </div>
        </div>
        <small>Wissensraum · 1.0</small>
      </aside>
      <main className="login-main">
        <div className="login-card">
          <span className="login-key">
            <KeyRound size={26} />
          </span>
          <h2>{bootstrap?.setup ? 'Wissensraum einrichten' : 'Willkommen zurück'}</h2>
          <p>Melde dich mit deinem Organisationszugang an.</p>
          {bootstrap?.setup && (
            <Notice kind="info">
              Der erste erfolgreich angemeldete Benutzer erhält dauerhaft die Administratorrolle.
            </Notice>
          )}

          <div className="login-actions">
            <a className="button primary full" href={loginUrl}>
              Zum Organisationslogin <ArrowRight size={18} />
            </a>
            <Notice>{error}</Notice>
          </div>

          <div style={{ marginTop: '20px', textAlign: 'center' }}>
            <button
              type="button"
              className="link-button"
              onClick={() => setShowManualToken(!showManualToken)}
              style={{
                fontSize: '0.78rem',
                color: '#64748b',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                textDecoration: 'underline',
              }}
            >
              {showManualToken
                ? 'Manuelle Eingabe verbergen'
                : 'Zugangs-Token manuell eingeben (Fallback)'}
            </button>
          </div>

          {showManualToken && (
            <form onSubmit={submit} style={{ marginTop: '16px' }}>
              <label htmlFor="jwt">Zugangs-Token (JWT)</label>
              <input
                id="jwt"
                type="password"
                autoComplete="off"
                spellCheck="false"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Token deines Identitätsanbieters"
                required
                maxLength={16000}
              />
              <p className="field-help">
                Der Token wird von deinem externen Identitätsanbieter ausgestellt.
              </p>
              <button
                className="button secondary full"
                disabled={busy || !token.trim()}
                style={{ marginTop: '8px' }}
              >
                {busy ? <Spinner /> : <ArrowRight size={18} />}{' '}
                {busy ? 'Anmeldung prüfen …' : 'Mit Token anmelden'}
              </button>
            </form>
          )}

          <p className="login-foot">
            <ShieldCheck size={16} /> Chats werden nicht auf dem Server gespeichert.
          </p>
        </div>
      </main>
    </div>
  );
}
