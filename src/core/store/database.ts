import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_PROFILE, type SignInRecord } from '../accounts/sign-in-status.ts';
import type { ProviderSetting } from '../providers/settings.ts';
import type { UnavailableModel } from '../models/availability.ts';
import type { ModelStat } from '../models/stats.ts';

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
  `CREATE TABLE account_state_v2 (
    account_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'healthy',
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    cooldown_until INTEGER,
    quota_reset_at INTEGER,
    last_used_at INTEGER,
    last_success_at INTEGER,
    last_error_at INTEGER,
    last_error TEXT,
    PRIMARY KEY (provider, account_id)
  )`,
  'INSERT INTO account_state_v2 SELECT * FROM account_state',
  'DROP TABLE account_state',
  'ALTER TABLE account_state_v2 RENAME TO account_state',
  `CREATE TABLE conversation_routes (
    conversation_id TEXT PRIMARY KEY,
    requested_model TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE model_stats (
    model TEXT PRIMARY KEY,
    successes INTEGER NOT NULL,
    failures INTEGER NOT NULL,
    latency_ms INTEGER,
    last_outcome TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE web_sign_in (
    provider TEXT PRIMARY KEY,
    signed_in INTEGER NOT NULL,
    reason TEXT,
    checked_at INTEGER NOT NULL
  )`,
  `CREATE TABLE provider_settings (
    provider TEXT PRIMARY KEY,
    auto INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE web_sign_in_v2 (
    provider TEXT NOT NULL,
    profile TEXT NOT NULL,
    signed_in INTEGER NOT NULL,
    reason TEXT,
    checked_at INTEGER NOT NULL,
    PRIMARY KEY (provider, profile)
  )`,
  `INSERT INTO web_sign_in_v2 (provider, profile, signed_in, reason, checked_at)
    SELECT provider, 'default', signed_in, reason, checked_at FROM web_sign_in`,
  'DROP TABLE web_sign_in',
  'ALTER TABLE web_sign_in_v2 RENAME TO web_sign_in',
  `CREATE TABLE browser_profiles (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE gateway_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE unavailable_models (
    model TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    until INTEGER NOT NULL
  )`,
];

export function defaultDatabaseFile() {
  return path.resolve(process.env.DATA_DIR || 'data', 'gateway.db');
}

function migrate(db: Database) {
  const { user_version: current } = db.query('PRAGMA user_version').get() as { user_version: number };
  if (current > MIGRATIONS.length) throw new Error(`Database schema ${current} is newer than this build supports`);
  db.transaction(() => {
    for (let version = current; version < MIGRATIONS.length; version++) db.run(MIGRATIONS[version]!);
    db.run(`PRAGMA user_version = ${MIGRATIONS.length}`);
  })();
}

export function openDatabase(file = defaultDatabaseFile()) {
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

export function loadModelStats(db: Database): ModelStat[] {
  return (db.query(`SELECT model, successes, failures, latency_ms AS latencyMs, last_outcome AS lastOutcome,
    updated_at AS updatedAt FROM model_stats`).all() as Array<ModelStat & { latencyMs: number | null }>)
    .map(({ latencyMs, ...stat }) => latencyMs === null ? stat : { ...stat, latencyMs });
}

export function saveModelStat(db: Database, stat: ModelStat) {
  db.query(`INSERT INTO model_stats (model, successes, failures, latency_ms, last_outcome, updated_at)
    VALUES ($model, $successes, $failures, $latencyMs, $lastOutcome, $updatedAt)
    ON CONFLICT (model) DO UPDATE SET successes = excluded.successes, failures = excluded.failures,
      latency_ms = excluded.latency_ms, last_outcome = excluded.last_outcome, updated_at = excluded.updated_at`).run({
    model: stat.model,
    successes: stat.successes,
    failures: stat.failures,
    latencyMs: stat.latencyMs ?? null,
    lastOutcome: stat.lastOutcome,
    updatedAt: stat.updatedAt,
  });
}

export function loadUnavailableModels(db: Database, now = Date.now()): UnavailableModel[] {
  return db.query('SELECT model, reason, until FROM unavailable_models WHERE until > $now').all({ now }) as UnavailableModel[];
}

export function replaceUnavailableModels(db: Database, entries: UnavailableModel[]) {
  db.transaction(() => {
    db.run('DELETE FROM unavailable_models');
    const insert = db.query('INSERT INTO unavailable_models (model, reason, until) VALUES ($model, $reason, $until)');
    for (const entry of entries) insert.run({ model: entry.model, reason: entry.reason, until: entry.until });
  })();
}

export function saveSignIn(db: Database, record: SignInRecord) {
  db.query(`INSERT INTO web_sign_in (provider, profile, signed_in, reason, checked_at) VALUES ($provider, $profile, $signedIn, $reason, $checkedAt)
    ON CONFLICT (provider, profile) DO UPDATE SET signed_in = excluded.signed_in, reason = excluded.reason, checked_at = excluded.checked_at`).run({
    provider: record.provider,
    profile: record.profile ?? DEFAULT_PROFILE,
    signedIn: record.signedIn ? 1 : 0,
    reason: record.reason ?? null,
    checkedAt: record.checkedAt,
  });
}

type SignInRow = { provider: string; profile: string; signedIn: number; reason: string | null; checkedAt: number };

function signInRecord(row: SignInRow): SignInRecord {
  return { provider: row.provider, profile: row.profile, signedIn: row.signedIn === 1, checkedAt: row.checkedAt, ...(row.reason ? { reason: row.reason } : {}) };
}

export function loadSignIn(db: Database, provider: string, profile = DEFAULT_PROFILE): SignInRecord | undefined {
  const row = db.query(`SELECT provider, profile, signed_in AS signedIn, reason, checked_at AS checkedAt FROM web_sign_in
    WHERE provider = $provider AND profile = $profile`).get({ provider, profile }) as SignInRow | null;
  return row ? signInRecord(row) : undefined;
}

export function loadSignIns(db: Database, provider: string): SignInRecord[] {
  return (db.query(`SELECT provider, profile, signed_in AS signedIn, reason, checked_at AS checkedAt FROM web_sign_in
    WHERE provider = $provider ORDER BY profile`).all({ provider }) as SignInRow[]).map(signInRecord);
}

export interface BrowserProfileRow {
  id: string;
  label: string;
  createdAt: number;
}

export function listBrowserProfiles(db: Database): BrowserProfileRow[] {
  return db.query(`SELECT id, label, created_at AS createdAt FROM browser_profiles ORDER BY created_at, id`).all() as BrowserProfileRow[];
}

export function addBrowserProfile(db: Database, profile: BrowserProfileRow) {
  db.query(`INSERT INTO browser_profiles (id, label, created_at) VALUES ($id, $label, $createdAt)`).run({ ...profile });
}

export function removeBrowserProfile(db: Database, id: string) {
  db.query(`DELETE FROM web_sign_in WHERE profile = $id`).run({ id });
  return db.query(`DELETE FROM browser_profiles WHERE id = $id`).run({ id }).changes > 0;
}

export function saveProviderSetting(db: Database, setting: ProviderSetting) {
  db.query(`INSERT INTO provider_settings (provider, auto, updated_at) VALUES ($provider, $auto, $updatedAt)
    ON CONFLICT (provider) DO UPDATE SET auto = excluded.auto, updated_at = excluded.updated_at`).run({
    provider: setting.provider,
    auto: setting.auto ? 1 : 0,
    updatedAt: setting.updatedAt,
  });
}

export function loadProviderSetting(db: Database, provider: string): ProviderSetting | undefined {
  const row = db.query(`SELECT provider, auto, updated_at AS updatedAt FROM provider_settings WHERE provider = $provider`)
    .get({ provider }) as { provider: string; auto: number; updatedAt: number } | null;
  return row ? { provider: row.provider, auto: row.auto === 1, updatedAt: row.updatedAt } : undefined;
}

export function saveGatewaySetting(db: Database, key: string, value: string, now = Date.now()) {
  db.query(`INSERT INTO gateway_settings (key, value, updated_at) VALUES ($key, $value, $now)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run({ key, value, now });
}

export function loadGatewaySetting(db: Database, key: string): string | undefined {
  const row = db.query(`SELECT value FROM gateway_settings WHERE key = $key`).get({ key }) as { value: string } | null;
  return row?.value;
}
