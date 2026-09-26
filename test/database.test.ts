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
