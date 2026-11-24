import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PATHS } from './paths.js';
import { KNOWLEDGE_TABLES, KNOWLEDGE_ADDITIVE_COLUMNS, KNOWLEDGE_POST_COLUMN_INDEXES } from './knowledge-schema.js';

let db: Database.Database | null = null;
let dbPathOverride: string | null = null;
let migrationsRun = false;

const SCHEMA_VERSION = 2;

const MIGRATIONS = [
  `-- memories table
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    snapshot_name TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    summary TEXT,
    content_type TEXT DEFAULT 'text',
    project_path TEXT,
    source_uri TEXT,
    token_count INTEGER DEFAULT 0,
    retrieval_count INTEGER DEFAULT 0,
    rank REAL DEFAULT 0.15,
    created_at TEXT NOT NULL,
    created_at_turn INTEGER,
    last_retrieved_turn INTEGER,
    last_retrieved_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_memories_snapshot ON memories(snapshot_name);
  CREATE INDEX IF NOT EXISTS idx_memories_content_type ON memories(content_type);
  CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_path);
  CREATE INDEX IF NOT EXISTS idx_memories_rank ON memories(rank DESC);
  CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);`,

  `-- transcripts table
  CREATE TABLE IF NOT EXISTS transcripts (
    memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
    transcript TEXT,
    embedding BLOB,
    embedding_model TEXT,
    topics TEXT,
    updated_at TEXT,
    content_format TEXT,
    language TEXT,
    mime_type TEXT,
    dimensions TEXT,
    file_path TEXT,
    url TEXT,
    fetched_at TEXT,
    skill_name TEXT,
    skill_commands TEXT,
    skill_instructions TEXT,
    skill_prompt TEXT,
    tool_name TEXT,
    tool_parameters TEXT,
    tool_description TEXT,
    tool_category TEXT,
    tool_schema TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_transcripts_topics ON transcripts(topics);
  CREATE INDEX IF NOT EXISTS idx_transcripts_skill ON transcripts(skill_name);
  CREATE INDEX IF NOT EXISTS idx_transcripts_tool ON transcripts(tool_name);
  CREATE INDEX IF NOT EXISTS idx_transcripts_url ON transcripts(url);`,

  `-- edges table
  -- edge_type distinguishes co-retrieval edges (default, Hebbian) from
  -- derived_from provenance edges (Phase G memory DNA) and future
  -- semantic_similarity / skill_link variants (Phase H/I).
  CREATE TABLE IF NOT EXISTS edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    edge_type TEXT NOT NULL DEFAULT 'co_retrieval',
    weight REAL DEFAULT 0.15,
    co_retrieval_count INTEGER DEFAULT 0,
    invalidation_count INTEGER DEFAULT 0,
    last_reinforced_turn INTEGER,
    last_reinforced_at TEXT,
    last_invalidated_turn INTEGER,
    created_at TEXT NOT NULL,
    created_at_turn INTEGER,
    UNIQUE(source_id, target_id)
  );
  CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
  CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
  CREATE INDEX IF NOT EXISTS idx_edges_weight ON edges(weight DESC);`,

  `-- sessions table
  -- last_turn is the per-session turn counter (DD#2). Each user session
  -- has its own clock; activation-decay turn stamps still use the global
  -- turn_counter key in the state table.
  -- surfaced_memories: JSON array of MemoryIds Claude has been made aware of
  -- this session — either pushed via digest or pulled via johnny_recall.
  -- Used to dedupe hints (Phase G).
  -- recalled_memory_ids: JSON array of MemoryIds whose chunks Claude pulled
  -- via johnny_recall this session. Read by the snapshot action to emit
  -- bidirectional derived_from provenance edges (Phase G).
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    project_path TEXT,
    last_prompt_at TEXT,
    last_cwd TEXT,
    last_action TEXT,
    active_memory_id TEXT REFERENCES memories(id),
    surfaced_memories TEXT,
    recalled_memory_ids TEXT,
    ask_candidates TEXT,
    last_turn INTEGER DEFAULT 0
  );`,

  `-- state table for key-value
  CREATE TABLE IF NOT EXISTS state (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT
  );
  INSERT OR IGNORE INTO state (key, value, updated_at) VALUES ('turn_counter', '0', datetime('now'));
  INSERT OR IGNORE INTO state (key, value, updated_at) VALUES ('rank_updated_turn', '0', datetime('now'));
  INSERT OR IGNORE INTO state (key, value, updated_at) VALUES ('schema_version', '${SCHEMA_VERSION}', datetime('now'));`,

  `-- FTS5 virtual table — stored-content (duplicates title/summary/transcript/topics
  -- into the FTS index). Simpler and safer than contentless mode when source data
  -- lives in two tables. Populated by triggers below.
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    title,
    summary,
    transcript,
    topics
  );

  -- Memories: insert a stub FTS row keyed by rowid; transcript/topics filled in
  -- when the transcript arrives.
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, title, summary, transcript, topics)
    VALUES (new.rowid, new.title, COALESCE(new.summary, ''), '', '');
  END;

  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    DELETE FROM memories_fts WHERE rowid = old.rowid;
  END;

  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    UPDATE memories_fts
    SET title = new.title, summary = COALESCE(new.summary, '')
    WHERE rowid = new.rowid;
  END;

  -- Transcripts: update the matching memory's FTS row with transcript/topics.
  CREATE TRIGGER IF NOT EXISTS transcripts_ai AFTER INSERT ON transcripts BEGIN
    UPDATE memories_fts
    SET transcript = COALESCE(new.transcript, ''),
        topics = COALESCE(new.topics, '')
    WHERE rowid = (SELECT rowid FROM memories WHERE id = new.memory_id);
  END;

  CREATE TRIGGER IF NOT EXISTS transcripts_au AFTER UPDATE ON transcripts BEGIN
    UPDATE memories_fts
    SET transcript = COALESCE(new.transcript, ''),
        topics = COALESCE(new.topics, '')
    WHERE rowid = (SELECT rowid FROM memories WHERE id = new.memory_id);
  END;

  CREATE TRIGGER IF NOT EXISTS transcripts_ad AFTER DELETE ON transcripts BEGIN
    UPDATE memories_fts
    SET transcript = '', topics = ''
    WHERE rowid = (SELECT rowid FROM memories WHERE id = old.memory_id);
  END;`,

  `-- chunks table — sub-memory units for Mosaic Recall (Phase G/H).
  -- A chunk is a stable, addressable slice of a memory's transcript with its
  -- own embedding, scored independently for retrieval. chunk_id is a stable
  -- string ('slug#3') so Claude can reference specific excerpts across turns.
  -- embedding_model pins the cosine-score validity boundary: scores from a
  -- chunk embedded under model X are not directly comparable to a query
  -- embedded under model Y. Re-embed when model changes.
  CREATE TABLE IF NOT EXISTS chunks (
    chunk_id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    embedding BLOB,
    embedding_model TEXT,
    chunker_version TEXT,
    token_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE(memory_id, chunk_index)
  );
  CREATE INDEX IF NOT EXISTS idx_chunks_memory ON chunks(memory_id);`,

  `-- recall_telemetry — one row per johnny_recall MCP call. Used to compute
  -- hint→recall conversion rates and tune retrieval thresholds (Phase G Q4a).
  CREATE TABLE IF NOT EXISTS recall_telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    called_at TEXT NOT NULL,
    query TEXT,
    requested_names TEXT,
    excluded_chunk_ids TEXT,
    chunks_returned INTEGER DEFAULT 0,
    memory_ids TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_recall_telemetry_session ON recall_telemetry(session_id);
  CREATE INDEX IF NOT EXISTS idx_recall_telemetry_called ON recall_telemetry(called_at DESC);`,

  `-- skill_candidates — Praxis sleep-phase discoveries awaiting user approval.
  -- status: 'proposed' | 'approved' | 'dismissed'
  -- source_memory_ids: JSON string[] of memory IDs that formed this cluster
  -- topics: JSON string[] — the shared topic core
  CREATE TABLE IF NOT EXISTS skill_candidates (
    id           TEXT PRIMARY KEY,
    slug         TEXT NOT NULL UNIQUE,
    topics       TEXT NOT NULL,
    source_memory_ids TEXT NOT NULL,
    cluster_score REAL DEFAULT 0,
    discovery_turn INTEGER,
    status       TEXT NOT NULL DEFAULT 'proposed',
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_skill_candidates_status ON skill_candidates(status);
  CREATE INDEX IF NOT EXISTS idx_skill_candidates_slug   ON skill_candidates(slug);`,

  `-- action_history — one row per evaluate() call. Source of truth for the
  -- observability dashboard's action distribution and "last fired" timestamps.
  -- Replaces grep-the-log for action data. Append-only.
  CREATE TABLE IF NOT EXISTS action_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    turn        INTEGER NOT NULL,
    ts          TEXT NOT NULL,
    intent      TEXT,
    confidence  TEXT,
    cmv_pressure   INTEGER,
    limit_pressure INTEGER,
    action      TEXT NOT NULL,
    matched_memory_id TEXT,
    duration_ms INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_action_history_ts ON action_history(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_action_history_action ON action_history(action);`,

  `-- daemon_heartbeats — one row per subsystem, updated on every tick.
  -- Dashboard checks last_pulse against expected interval to flag stalls.
  CREATE TABLE IF NOT EXISTS daemon_heartbeats (
    subsystem   TEXT PRIMARY KEY,
    last_pulse  TEXT NOT NULL,
    last_work   TEXT,
    status      TEXT NOT NULL DEFAULT 'ok'
  );`,

  `-- error_telemetry — append-only record of caught errors that would otherwise
  -- be silently swallowed. Surfaces the unknown-unknowns: ollama hiccups,
  -- chunk failures, snapshot collisions. Severity bands let the dashboard
  -- distinguish "noise" (benign) from "alert me" (error/fatal).
  CREATE TABLE IF NOT EXISTS error_telemetry (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        TEXT NOT NULL,
    source    TEXT NOT NULL,
    severity  TEXT NOT NULL,
    message   TEXT NOT NULL,
    session_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_error_telemetry_ts ON error_telemetry(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_error_telemetry_source ON error_telemetry(source);`,

  `-- hint_telemetry — one row per additionalContext emission (hint or
  -- recommend_memory). Pairs with recall_telemetry to measure conversion.
  -- form values: 'form1' | 'form2' | 'form3' | 'recommend_memory' | 'bootstrap' | 'offer'.
  CREATE TABLE IF NOT EXISTS hint_telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    emitted_at TEXT NOT NULL,
    form TEXT NOT NULL,
    suggested_memory_ids TEXT,
    top_score REAL,
    threshold REAL,
    token_estimate INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_hint_telemetry_session ON hint_telemetry(session_id);
  CREATE INDEX IF NOT EXISTS idx_hint_telemetry_emitted ON hint_telemetry(emitted_at DESC);`,

];

export type ContentType =
  | 'text'
  | 'markdown'
  | 'code'
  | 'webpage'
  | 'image'
  | 'plan'
  | 'doc'
  | 'skill'
  | 'tool'
  | 'schema';  // quarantined gist nodes from sleep/schema-extraction — excluded from recall until approved

export type JohnnyDatabase = Database.Database;

export function setDatabasePath(p: string | ':memory:'): void {
  if (db) {
    db.close();
    db = null;
  }
  migrationsRun = false;
  dbPathOverride = p;
}

export function getDatabase(): Database.Database {
  if (db) return db;

  const dbPath = dbPathOverride ?? PATHS.database;

  if (dbPath !== ':memory:') {
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // 5s busy timeout: when the daemon, hooks, and MCP subprocess all write at
  // once, queue rather than fail immediately. WAL handles read concurrency;
  // busy_timeout is what handles write contention without a SqliteError.
  db.pragma('busy_timeout = 5000');

  if (!migrationsRun) {
    for (const sql of MIGRATIONS) {
      db.exec(sql);
    }
    for (const sql of KNOWLEDGE_TABLES) {
      db.exec(sql);
    }
    applyAdditiveColumns(db);
    migrationsRun = true;
  }

  return db;
}

// Additive ALTER TABLE migrations for DBs created under an earlier schema.
// better-sqlite3's table_info gives us column presence without a schema_version
// bump. Each added column must be nullable or have a default, since existing
// rows acquire the column value at ADD time.
function applyAdditiveColumns(d: Database.Database): void {
  const need = (table: string, col: string, ddl: string) => {
    const rows = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!rows.some(r => r.name === col)) {
      d.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  };
  need('sessions', 'ask_candidates', 'ask_candidates TEXT');
  need('sessions', 'last_turn', 'last_turn INTEGER DEFAULT 0');
  need('sessions', 'active_memory_id', 'active_memory_id TEXT');

  // Phase G: rename legacy injected_memories → surfaced_memories. Old DBs
  // built before Phase G have the legacy name; modern fresh DBs have the new
  // name from the CREATE TABLE. Use ALTER ... RENAME COLUMN (SQLite ≥3.25).
  const sessionCols = d.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[];
  const hasLegacy = sessionCols.some(r => r.name === 'injected_memories');
  const hasNew = sessionCols.some(r => r.name === 'surfaced_memories');
  if (hasLegacy && !hasNew) {
    d.exec(`ALTER TABLE sessions RENAME COLUMN injected_memories TO surfaced_memories`);
  } else if (!hasNew) {
    d.exec(`ALTER TABLE sessions ADD COLUMN surfaced_memories TEXT`);
  }
  need('sessions', 'recalled_memory_ids', 'recalled_memory_ids TEXT');
  need('hint_telemetry', 'prompt_excerpt', 'prompt_excerpt TEXT');
  need('sessions', 'last_snapshot_line', 'last_snapshot_line INTEGER NOT NULL DEFAULT 0');
  need('sessions', 'last_snapshot_at', 'last_snapshot_at TEXT');
  need('sessions', 'last_trim_at', 'last_trim_at TEXT');

  // Knowledge layer + Phase 0 substrate guards (chunk content hash, snapshot
  // ledger anchor, memory supersession). See src/store/knowledge-schema.ts.
  for (const [table, col, ddl] of KNOWLEDGE_ADDITIVE_COLUMNS) need(table, col, ddl);
  for (const sql of KNOWLEDGE_POST_COLUMN_INDEXES) d.exec(sql);

  // Phase G: edges grow an edge_type tag (co_retrieval default, derived_from
  // for provenance). Backfill all existing rows to 'co_retrieval' since every
  // pre-G edge was created by Hebbian co-retrieval.
  need('edges', 'edge_type', `edge_type TEXT NOT NULL DEFAULT 'co_retrieval'`);

  // Phase G: pin embedding-model name to chunks and transcripts so cosine
  // scores remain comparable only within the same model generation.
  need('transcripts', 'embedding_model', 'embedding_model TEXT');
  need('chunks', 'chunker_version', 'chunker_version TEXT');

  // Single-gate scorer: add recall_score to action_history.
  need('action_history', 'recall_score', 'recall_score REAL');

  // FTS5 migration: legacy DBs built memories_fts with content='memories',
  // which asks the virtual table to read transcript/topics back from the
  // memories table. Those columns live on transcripts, so every INSERT trigger
  // errors with "no such column: T.transcript". Rebuild in stored-content mode.
  const ftsRow = d.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='memories_fts'`
  ).get() as { sql: string } | undefined;
  if (ftsRow && /content\s*=\s*'?memories'?/i.test(ftsRow.sql)) {
    d.exec(`
      DROP TRIGGER IF EXISTS memories_ai;
      DROP TRIGGER IF EXISTS memories_ad;
      DROP TRIGGER IF EXISTS memories_au;
      DROP TRIGGER IF EXISTS transcripts_ai;
      DROP TRIGGER IF EXISTS transcripts_au;
      DROP TRIGGER IF EXISTS transcripts_ad;
      DROP TABLE IF EXISTS memories_fts;
      CREATE VIRTUAL TABLE memories_fts USING fts5(title, summary, transcript, topics);
      INSERT INTO memories_fts(rowid, title, summary, transcript, topics)
        SELECT m.rowid, m.title, COALESCE(m.summary, ''),
               COALESCE(t.transcript, ''), COALESCE(t.topics, '')
        FROM memories m
        LEFT JOIN transcripts t ON t.memory_id = m.id;
      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, title, summary, transcript, topics)
        VALUES (new.rowid, new.title, COALESCE(new.summary, ''), '', '');
      END;
      CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        DELETE FROM memories_fts WHERE rowid = old.rowid;
      END;
      CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
        UPDATE memories_fts SET title = new.title, summary = COALESCE(new.summary, '')
        WHERE rowid = new.rowid;
      END;
      CREATE TRIGGER transcripts_ai AFTER INSERT ON transcripts BEGIN
        UPDATE memories_fts
        SET transcript = COALESCE(new.transcript, ''), topics = COALESCE(new.topics, '')
        WHERE rowid = (SELECT rowid FROM memories WHERE id = new.memory_id);
      END;
      CREATE TRIGGER transcripts_au AFTER UPDATE ON transcripts BEGIN
        UPDATE memories_fts
        SET transcript = COALESCE(new.transcript, ''), topics = COALESCE(new.topics, '')
        WHERE rowid = (SELECT rowid FROM memories WHERE id = new.memory_id);
      END;
      CREATE TRIGGER transcripts_ad AFTER DELETE ON transcripts BEGIN
        UPDATE memories_fts SET transcript = '', topics = ''
        WHERE rowid = (SELECT rowid FROM memories WHERE id = old.memory_id);
      END;
    `);
  }
}

export function runMigrations(): void {
  getDatabase();
}

export function initDatabase(): Database.Database {
  return getDatabase();
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
  migrationsRun = false;
}