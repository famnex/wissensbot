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
