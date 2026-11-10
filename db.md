# Datenbankdokumentation (db.md)

Dieses Dokument beschreibt die vollständige Struktur der SQLite-Datenbank des Projekts **Wissensraum** (`knowledge.sqlite`).
Es dient als Referenz für die Funktionsweise, Migrationen und spätere Update-Skripte.

---

## Allgemeine Konfiguration & Betriebsmodus

- **Datenbank-Engine:** SQLite 3 über `better-sqlite3` (Node.js)
- **Dateispeicherort:** Standardmäßig unter `$DATA_DIR/knowledge.sqlite` (z. B. `var/knowledge.sqlite`)
- **Journal-Modus:** `WAL` (Write-Ahead Logging) für parallele Lese- und Schreibzugriffe
- **Synchronisation:** `synchronous = FULL` für maximale Konsistenz und Crash-Sicherheit
- **Fremdschlüssel:** `foreign_keys = ON` (Kaskadierendes Löschen aktiv)
- **Sperrzeit:** `busy_timeout = 5000` ms
- **Tabellentyp:** Alle Tabellen nutzen den SQLite `STRICT`-Modus zur strikten Durchsetzung von Datentypen.

---

## Tabellenübersicht

| Tabelle | Zweck | Primärschlüssel |
|---|---|---|
| `schema_migrations` | Versionierung und SHA-256-Prüfsummen aller ausgeführten Migrationen | `version` |
| `users` | Benutzerkonten mit Rollen (`admin`, `editor`, `user`) und Login-Zeitstempeln | `id` |
| `settings` | Globale Konfigurationseinstellungen (z. B. Setup-Status, Gemini API-Key) | `key` |
| `sources` | Wissensquellen (Text, Datei-Uploads, URLs) und deren Verarbeitungsstatus | `id` |
| `chunks` | Textabschnitte der indexierten Quellen inklusive Float32-Vektor-BLOBs | `id` |
| `jobs` | Persistente Job-Warteschlange für Extraktion und Indexierung (Leasing-Mechanismus) | `id` |
| `runtime` | Flüchtige Laufzeitmetadaten (z. B. Worker-Heartbeat) | `key` |
| `audit` | Revisionssicheres Audit-Log administrativer Aktionen | `id` |
| `inbox` | Wissens-Inbox für unbeantwortete Fragen und Wissenslücken | `id` |

---

## Detaillierte Tabellendefinitionen

### 1. `schema_migrations`
Verwaltet vom Migrationssystem (`server/db/index.mjs`):
```sql
CREATE TABLE schema_migrations (
  version TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
) STRICT;
```
- `version`: Dateiname der Migration (z. B. `001_initial.sql`, `002_chunk_titles.sql`).
- `checksum`: SHA-256-Hash des Inhalts der SQL-Datei zur Erkennung nachträglicher Manipulationen.
- `applied_at`: Unix-Zeitstempel in Millisekunden.

#### Historie der Migrationen:
1. `001_initial.sql`: Initiales Datenbankschema (Tabellen: `users`, `settings`, `sources`, `chunks`, `jobs`, `runtime`, `audit`).
2. `002_chunk_titles.sql`: `ALTER TABLE chunks ADD COLUMN title TEXT;` für editierbare Chunk-Titel.
3. `003_unanswered_inbox.sql`: `CREATE TABLE inbox (...);` für die Wissens-Inbox unbeantworteter Fragen.

---

### 2. `users`
Speichert Benutzerkonten. Identitäten werden extern per JWT validiert (`issuer` + `subject`):
```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','editor','user')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  created_at INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL,
  UNIQUE(issuer, subject)
) STRICT;
```
- `role`: Rollenmodell:
  - `admin`: Vollzugriff inkl. Einstellungen, API-Keys, Modellwahl, Benutzerverwaltung und Updates.
  - `editor`: Darf Quellen anlegen, deaktivieren, neu indexieren und löschen.
  - `user`: Ausschließlich Chat-Zugriff auf freigegebene Wissensinhalte.
- Der erste jemals erfolgreich angemeldete Benutzer erhält atomar die Rolle `admin`.

---

### 3. `settings`
Key-Value-Speicher für System- und Modelleinstellungen:
```sql
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
```
Bekannte Schlüssel:
- `first_admin_completed`: `'true'`, sobald der erste Administrator initialisiert wurde.
- `gemini_api_key`: AES-256-GCM verschlüsselter String (mit `APP_ENCRYPTION_KEY`).
- `gemini_chat_model`: Name des konfigurierten Chat-Modells (z. B. `models/gemini-2.5-flash`).
- `gemini_embedding_model`: Name des Embedding-Modells (z. B. `models/gemini-embedding-001`).

---

### 4. `sources`
Verwaltet die Wissensbasis:
```sql
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('text','file','url')),
  reference TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','indexing','ready','error')),
  documents_json TEXT,
  error TEXT,
  warning TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_sources_status_active ON sources(active, status);
```
- `type`:
  - `text`: Direkte Texteingabe oder `!learn`-Befehl aus dem Chat.
  - `file`: Hochgeladene Datei (PDF, DOCX, XLSX, CSV, TXT, MD).
  - `url`: Gecrawlte Webseite (Tiefe bis 2, Same-Origin).
- `reference`: Ursprünglicher Dateiname oder Start-URL.
- `documents_json`: JSON-Metadaten der extrahierten Unterdokumente bzw. Crawl-Ergebnisse.
- `chunk_count`: Anzahl der erzeugten Chunks in der Tabelle `chunks`.

---

### 5. `chunks`
Enthält die zerlegten Textblöcke und deren Vektoren für das RAG-Retrieval:
```sql
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  location TEXT NOT NULL,
  url TEXT,
  vector BLOB NOT NULL,
  profile TEXT NOT NULL,
  title TEXT,
  UNIQUE(source_id, ordinal)
) STRICT;

CREATE INDEX idx_chunks_profile_source ON chunks(profile, source_id);
```
- `title`: Optionaler prägnanter Titel/Überschrift des Wissensabschnitts (ab Migration `002_chunk_titles.sql`). Kann im Dashboard editiert werden.
- `text`: Reiner Textabschnitt (ca. 1.800 Zeichen mit 220 Zeichen Überlappung). Im Dashboard editierbar (führt zur Neu-Vektorisierung).
- `location`: Lokalisierungsinformation (z. B. Seitenzahl bei PDF, Tabellenblatt bei Excel, Überschrift).
- `vector`: Normalisierter 768-dimensionaler Float32-Vektor als Binär-BLOB (3.072 Bytes).
- `profile`: Kennung des verwendeten Modells und Formats (z. B. `gemini-embedding-001:v1`), um Vektorinkompatibilitäten bei Modellwechseln auszuschließen.

---

### 6. `jobs`
Robuste, persistente Job-Warteschlange für Hintergrundprozesse (Worker):
```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('ingest','reindex')),
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','done','failed')),
  stage TEXT NOT NULL DEFAULT 'Warteschlange',
  progress INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  lease_owner TEXT,
  lease_until INTEGER,
  run_after INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_jobs_claim ON jobs(status, run_after, created_at);
CREATE UNIQUE INDEX idx_jobs_one_active ON jobs(source_id) WHERE status IN ('queued','processing');
```
- Verhindert Mehrfachverarbeitung aktiver Quellen (`idx_jobs_one_active`).
- Verwendet Lease-Timeout (`lease_owner`, `lease_until`) für automatische Übernahme bei Worker-Abstürzen.
- Exponentieller Backoff über `run_after` bei temporären Fehlern.

---

### 7. `runtime`
Für flüchtige Statusanzeigen ohne Persistenzanforderung:
```sql
CREATE TABLE runtime (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
```
- `worker_heartbeat`: Unix-Zeitstempel des letzten Worker-Durchlaufs. Ermöglicht dem Webserver die Prüfung via `GET /api/health`, ob der Hintergrundprozess aktiv ist (`Date.now() - workerAt < 20000`).

---

### 8. `audit`
Audit-Log für sicherheitsrelevante Aktionen:
```sql
CREATE TABLE audit (
  id INTEGER PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  created_at INTEGER NOT NULL
) STRICT;
```
- Speichert den Akteur, die ausgeführte Aktion (z. B. `first_admin`, `role_changed`, `key_saved`) und das betroffene Ziel.
- Automatische Bereinigung nach 90 Tagen durch den Indexer-Worker.

---

### 9. `inbox`
Speichert unbeantwortete Fragen und Wissenslücken, die im Chat gestellt wurden:
```sql
CREATE TABLE inbox (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  answer TEXT,
  asked_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  asked_by_name TEXT,
  count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','dismissed')),
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_inbox_status_created ON inbox(status, created_at DESC);
CREATE INDEX idx_inbox_question ON inbox(question);
```
- `id`: Eindeutige UUID der Frage.
- `question`: Vom Benutzer gestellte Frage, die mangels Wissensbasis nicht beantwortet werden konnte.
- `answer`: Textantwort des Modells (Hinweis auf fehlendes Wissen).
- `asked_by`: Benutzer-ID des Fragestellers (optional / ON DELETE SET NULL).
- `asked_by_name`: Name des Fragestellers zum Zeitpunkt der Anfrage.
- `count`: Häufigkeitszähler (erhöht sich automatisch, wenn dieselbe Frage wiederholt gestellt wird).
- `status`:
  - `open`: Frage ist offen und muss redaktionell geprüft werden.
  - `resolved`: Wissenslücke wurde behoben (z. B. neues Wissen angelegt).
  - `dismissed`: Frage wurde verworfen (z. B. Spam oder irrelevant).
- `note`: Optionale interne Notiz für Redakteure/Administratoren.
- `created_at` / `updated_at`: Unix-Zeitstempel in Millisekunden.
