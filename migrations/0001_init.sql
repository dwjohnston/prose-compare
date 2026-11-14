-- Prose Skill Comparer schema. Tables follow SPEC.md "Data model and permanent storage".
CREATE TABLE comparison (
  id TEXT PRIMARY KEY,                -- short slug used in the permanent URL
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,                -- OpenRouter slug, e.g. anthropic/claude-sonnet-5.5
  harness_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  total_cost_usd REAL NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  rerun_of TEXT                       -- comparison this was "Run again" from, if any
);

CREATE TABLE lane (
  id TEXT PRIMARY KEY,
  comparison_id TEXT NOT NULL REFERENCES comparison(id) ON DELETE CASCADE,
  label TEXT,
  "order" INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  tokens_input INTEGER,
  tokens_output INTEGER,
  cost_usd REAL,
  duration_ms INTEGER,
  output_blob TEXT,                   -- R2 key
  events_blob TEXT,                   -- R2 key
  trace_blob TEXT,                    -- R2 key: parsed tool-call trace + anomalies (JSON)
  error TEXT,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX lane_comparison ON lane(comparison_id, "order");

CREATE TABLE skill_snapshot (
  id TEXT PRIMARY KEY,                -- sha256 of provenance (owner/repo/path@commit) + content_sha256
  content_sha256 TEXT NOT NULL,       -- sha256 of the canonical folder contents; files_blob is keyed by it
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  path TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  name TEXT NOT NULL,                 -- normalised name; also the folder/skill ID in the sandbox
  display_name TEXT NOT NULL,         -- frontmatter name as written
  description TEXT NOT NULL,
  files_blob TEXT NOT NULL,           -- R2 key (content-addressed: skills/<content_sha256>.json)
  UNIQUE (owner, repo, path, commit_sha)
);

CREATE TABLE lane_skill (
  lane_id TEXT NOT NULL REFERENCES lane(id) ON DELETE CASCADE,
  skill_snapshot_id TEXT NOT NULL REFERENCES skill_snapshot(id),
  "order" INTEGER NOT NULL DEFAULT 0,
  invocation_status TEXT CHECK (invocation_status IN ('triggered', 'load_failed', 'not_triggered', 'fetched_instead')),
  first_invoked_step INTEGER,
  before_first_text INTEGER,          -- 1 if loaded before any text was emitted
  files_read TEXT,                    -- JSON array of supporting files read
  PRIMARY KEY (lane_id, skill_snapshot_id)
);
CREATE INDEX lane_skill_snapshot ON lane_skill(skill_snapshot_id);

CREATE TABLE ledger_entry (
  id TEXT PRIMARY KEY,
  lane_id TEXT NOT NULL,              -- no FK: spend history outlives a deleted comparison
  cost_usd REAL NOT NULL,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
