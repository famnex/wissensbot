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
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
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
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  location TEXT NOT NULL,
  url TEXT,
  vector BLOB NOT NULL,
  profile TEXT NOT NULL,
  UNIQUE(source_id, ordinal)
) STRICT;
CREATE INDEX idx_chunks_profile_source ON chunks(profile, source_id);
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
CREATE TABLE runtime (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE audit (
  id INTEGER PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  created_at INTEGER NOT NULL
) STRICT;
