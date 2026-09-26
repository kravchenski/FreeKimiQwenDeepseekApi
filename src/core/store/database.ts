import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = [
  `CREATE TABLE account_state (
    account_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'healthy',
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    cooldown_until INTEGER,
    quota_reset_at INTEGER,
    last_used_at INTEGER,
    last_success_at INTEGER,
    last_error_at INTEGER,
    last_error TEXT
  )`,
  `CREATE TABLE quota_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    provider TEXT NOT NULL,
    account_id TEXT,
    type TEXT NOT NULL,
    reset_at INTEGER
  )`,
  `CREATE TABLE request_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    account_id TEXT,
    status TEXT NOT NULL,
    latency_ms INTEGER,
    error TEXT
  )`,
  'CREATE INDEX request_logs_created_at ON request_logs (created_at)',
];

export const DEFAULT_DATABASE_FILE = path.resolve(process.env.DATA_DIR || 'data', 'gateway.db');

function migrate(db: Database) {
  const { user_version: current } = db.query('PRAGMA user_version').get() as { user_version: number };
  if (current > MIGRATIONS.length) throw new Error(`Database schema ${current} is newer than this build supports`);
  db.transaction(() => {
    for (let version = current; version < MIGRATIONS.length; version++) db.run(MIGRATIONS[version]!);
    db.run(`PRAGMA user_version = ${MIGRATIONS.length}`);
  })();
}

export function openDatabase(file = DEFAULT_DATABASE_FILE) {
  const inMemory = file === ':memory:';
  if (!inMemory) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file, { create: true, strict: true });
  if (!inMemory) {
    fs.chmodSync(file, 0o600);
    db.run('PRAGMA journal_mode = WAL');
  }
  db.run('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

export interface RequestLog {
  provider: string;
  model: string;
  accountId?: string;
  status: 'success' | 'error';
  latencyMs?: number;
  error?: string;
}

export function recordRequest(db: Database, log: RequestLog, now = Date.now()) {
  db.query(`INSERT INTO request_logs (created_at, provider, model, account_id, status, latency_ms, error)
    VALUES ($createdAt, $provider, $model, $accountId, $status, $latencyMs, $error)`).run({
    createdAt: now,
    provider: log.provider,
    model: log.model,
    accountId: log.accountId ?? null,
    status: log.status,
    latencyMs: log.latencyMs ?? null,
    error: log.error ?? null,
  });
}

export function recentRequests(db: Database, limit = 50) {
  return db.query(`SELECT created_at AS createdAt, provider, model, account_id AS accountId, status,
    latency_ms AS latencyMs, error FROM request_logs ORDER BY id DESC LIMIT $limit`).all({ limit });
}
