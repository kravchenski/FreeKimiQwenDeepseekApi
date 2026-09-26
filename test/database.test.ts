import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase, recentRequests, recordRequest } from '../src/core/store/database.ts';

describe('gateway database', () => {
  test('creates the schema once and reopens without re-running migrations', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'db-')), 'nested', 'gateway.db');
    const db = openDatabase(file);
    recordRequest(db, { provider: 'qwen', model: 'qwen3.7-plus', status: 'success', latencyMs: 120 });
    db.close();

    const reopened = openDatabase(file);
    const tables = reopened.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    expect(tables).toEqual([{ name: 'account_state' }, { name: 'quota_events' }, { name: 'request_logs' }]);
    expect(recentRequests(reopened)).toHaveLength(1);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    reopened.close();
  });

  test('returns recent requests newest first with a limit', () => {
    const db = openDatabase(':memory:');
    recordRequest(db, { provider: 'qwen', model: 'a', status: 'success' }, 1);
    recordRequest(db, { provider: 'deepseek', model: 'b', status: 'error', accountId: 'ds-1', error: '429' }, 2);
    recordRequest(db, { provider: 'glm', model: 'c', status: 'success' }, 3);

    expect(recentRequests(db, 2)).toEqual([
      { createdAt: 3, provider: 'glm', model: 'c', accountId: null, status: 'success', latencyMs: null, error: null },
      { createdAt: 2, provider: 'deepseek', model: 'b', accountId: 'ds-1', status: 'error', latencyMs: null, error: '429' },
    ]);
  });

  test('stores untrusted text as data, not SQL', () => {
    const db = openDatabase(':memory:');
    const hostile = "x'); DROP TABLE request_logs; --";
    recordRequest(db, { provider: 'qwen', model: hostile, status: 'error', error: hostile });
    expect(recentRequests(db)[0]).toMatchObject({ model: hostile, error: hostile });
  });

  test('refuses a database created by a newer build', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'db-')), 'gateway.db');
    const future = new Database(file);
    future.run('PRAGMA user_version = 999');
    future.close();
    expect(() => openDatabase(file)).toThrow('newer than this build');
  });
});

describe('account_state migration', () => {
  test('keys account state by provider and account id, keeping existing rows', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'db-')), 'gateway.db');
    const legacy = new Database(file);
    legacy.run(`CREATE TABLE account_state (account_id TEXT PRIMARY KEY, provider TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'healthy',
      consecutive_failures INTEGER NOT NULL DEFAULT 0, cooldown_until INTEGER, quota_reset_at INTEGER, last_used_at INTEGER,
      last_success_at INTEGER, last_error_at INTEGER, last_error TEXT)`);
    legacy.run(`CREATE TABLE quota_events (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, provider TEXT NOT NULL,
      account_id TEXT, type TEXT NOT NULL, reset_at INTEGER)`);
    legacy.run(`CREATE TABLE request_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, provider TEXT NOT NULL,
      model TEXT NOT NULL, account_id TEXT, status TEXT NOT NULL, latency_ms INTEGER, error TEXT)`);
    legacy.run('CREATE INDEX request_logs_created_at ON request_logs (created_at)');
    legacy.run("INSERT INTO account_state (account_id, provider, consecutive_failures) VALUES ('a', 'qwen', 2)");
    legacy.run('PRAGMA user_version = 4');
    legacy.close();

    const db = openDatabase(file);
    db.run("INSERT INTO account_state (account_id, provider) VALUES ('a', 'deepseek')");
    expect(db.query('SELECT provider, consecutive_failures AS failures FROM account_state ORDER BY provider').all())
      .toEqual([{ provider: 'deepseek', failures: 0 }, { provider: 'qwen', failures: 2 }]);
    db.close();
  });
});
