CREATE TABLE chunk_attachments (
  id TEXT PRIMARY KEY,
  chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_chunk_attachments_chunk ON chunk_attachments(chunk_id);
