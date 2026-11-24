// SQLite DDL for the knowledge layer + Phase 0 substrate guards.
// Mirrors migrations/002_knowledge.sql (Postgres) — keep both in sync.
// Consumed by src/store/database.ts (MIGRATIONS + applyAdditiveColumns).

export const KNOWLEDGE_TABLES: string[] = [
  `CREATE TABLE IF NOT EXISTS snapshot_ledger (
    uuid TEXT PRIMARY KEY,
    session_id TEXT,
    memory_id TEXT,
    ingested_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ledger_session ON snapshot_ledger(session_id);
  CREATE INDEX IF NOT EXISTS idx_ledger_memory ON snapshot_ledger(memory_id);`,

  `CREATE TABLE IF NOT EXISTS job_state (
    job TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT '',
    watermark TEXT,
    claimed_by TEXT,
    claimed_at TEXT,
    pending INTEGER NOT NULL DEFAULT 0,
    fail_count INTEGER NOT NULL DEFAULT 0,
    paused INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    stats TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (job, scope)
  );`,

  `CREATE TABLE IF NOT EXISTS facts (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL DEFAULT 'global',
    text TEXT NOT NULL,
    context TEXT,
    kind TEXT NOT NULL DEFAULT 'state',
    occurred_start TEXT,
    occurred_end TEXT,
    mentioned_at TEXT,
    source_memory_id TEXT,
    source_chunk_id TEXT,
    source_quote TEXT,
    session_id TEXT,
    window_hash TEXT,
    extractor_version TEXT,
    embedding BLOB,
    embedding_model TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    superseded_by TEXT,
    valid_to TEXT,
    invalidation_count INTEGER NOT NULL DEFAULT 0,
    origin TEXT NOT NULL DEFAULT 'extracted',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_facts_scope_status ON facts(scope, status);
  CREATE INDEX IF NOT EXISTS idx_facts_memory ON facts(source_memory_id);
  CREATE INDEX IF NOT EXISTS idx_facts_created ON facts(created_at);
  CREATE INDEX IF NOT EXISTS idx_facts_window ON facts(window_hash);`,

  `CREATE TABLE IF NOT EXISTS fact_entities (
    fact_id TEXT NOT NULL,
    entity_norm TEXT NOT NULL,
    PRIMARY KEY (fact_id, entity_norm)
  );
  CREATE INDEX IF NOT EXISTS idx_fact_entities_entity ON fact_entities(entity_norm);`,

  `CREATE TABLE IF NOT EXISTS extraction_log (
    window_hash TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    status TEXT NOT NULL,
    fact_count INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    processed_at TEXT,
    PRIMARY KEY (window_hash, extractor_version)
  );`,

  `CREATE TABLE IF NOT EXISTS observations (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL DEFAULT 'global',
    facet TEXT,
    subject TEXT,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    superseded_by TEXT,
    valid_from TEXT,
    valid_to TEXT,
    proof_count INTEGER NOT NULL DEFAULT 0,
    review_state TEXT NOT NULL DEFAULT 'auto',
    embedding BLOB,
    embedding_model TEXT,
    consolidator_version TEXT,
    invalidation_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_evidence_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_obs_scope_status ON observations(scope, status);
  CREATE INDEX IF NOT EXISTS idx_obs_updated ON observations(updated_at);`,

  `CREATE TABLE IF NOT EXISTS observation_evidence (
    observation_id TEXT NOT NULL,
    fact_id TEXT NOT NULL,
    quote TEXT,
    role TEXT NOT NULL DEFAULT 'supports',
    added_at TEXT NOT NULL,
    PRIMARY KEY (observation_id, fact_id)
  );
  CREATE INDEX IF NOT EXISTS idx_obs_ev_fact ON observation_evidence(fact_id);`,

  `CREATE TABLE IF NOT EXISTS mental_models (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    source_query TEXT NOT NULL,
    query_embedding BLOB,
    section_embeddings BLOB,
    embedding_model TEXT,
    scope TEXT NOT NULL DEFAULT 'global',
    max_tokens INTEGER NOT NULL DEFAULT 800,
    content TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    origin TEXT NOT NULL DEFAULT 'auto',
    refresh_mode TEXT NOT NULL DEFAULT 'after_consolidation',
    last_refreshed_at TEXT,
    last_seen_at TEXT,
    based_on TEXT,
    force_stale INTEGER NOT NULL DEFAULT 0,
    fail_count INTEGER NOT NULL DEFAULT 0,
    paused INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_models_scope_status ON mental_models(scope, status);`,

  `CREATE TABLE IF NOT EXISTS knowledge_history (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    content TEXT,
    reason TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_khist_ref ON knowledge_history(kind, ref_id, version);`,

  `CREATE TABLE IF NOT EXISTS prime_events (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    session_id TEXT,
    trigger TEXT NOT NULL,
    outcome TEXT NOT NULL,
    refs TEXT,
    top_score REAL,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_prime_events_created ON prime_events(created_at);`,
];

// Additive columns on pre-existing tables: [table, column, ddl].
export const KNOWLEDGE_ADDITIVE_COLUMNS: Array<[string, string, string]> = [
  ['chunks', 'content_hash', 'content_hash TEXT'],
  ['sessions', 'last_snapshot_uuid', 'last_snapshot_uuid TEXT'],
  ['memories', 'superseded_by', 'superseded_by TEXT'],
  ['memories', 'valid_to', 'valid_to TEXT'],
  ['mental_models', 'section_embeddings', 'section_embeddings BLOB'],
];

// Indexes that depend on additive columns (must run after the columns exist).
export const KNOWLEDGE_POST_COLUMN_INDEXES: string[] = [
  'CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(content_hash)',
];
