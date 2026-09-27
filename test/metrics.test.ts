import { describe, expect, test } from 'bun:test';

import { Metrics, requestIdFrom } from '../src/observability/metrics.ts';

describe('Metrics', () => {
  test('renders counters, durations and gauges in Prometheus text format', () => {
    const metrics = new Metrics();
    metrics.record({ provider: 'deepseek', model: 'deepseek-default', status: 'success', latencyMs: 1500 });
    metrics.record({ provider: 'deepseek', model: 'deepseek-default', status: 'success', latencyMs: 500 });
    metrics.record({ provider: 'qwen', model: 'qwen3.7-plus', status: 'error' });
    const text = metrics.render({
      providers: [{ id: 'deepseek', available: true }, { id: 'nvidia', available: false }],
      accounts: [{ provider: 'qwen', status: 'healthy' }, { provider: 'qwen', status: 'healthy' }, { provider: 'qwen', status: 'cooldown' }],
    });
    expect(text).toContain('gateway_requests_total{provider="deepseek",model="deepseek-default",status="success"} 2');
    expect(text).toContain('gateway_request_duration_seconds_sum{provider="deepseek",model="deepseek-default",status="success"} 2.000');
    expect(text).toContain('gateway_requests_total{provider="qwen",model="qwen3.7-plus",status="error"} 1');
    expect(text).toContain('gateway_provider_available{provider="nvidia"} 0');
    expect(text).toContain('gateway_accounts{provider="qwen",status="healthy"} 2');
    expect(text).toContain('# TYPE gateway_requests_total counter');
    expect(text.endsWith('\n')).toBeTrue();
  });

  test('escapes label values', () => {
    const metrics = new Metrics();
    metrics.record({ provider: 'p"x', model: 'a\\b\nc', status: 'success' });
    expect(metrics.render({ providers: [], accounts: [] })).toContain('{provider="p\\"x",model="a\\\\b\\nc",status="success"} 1');
  });
});

describe('requestIdFrom', () => {
  test('keeps safe incoming ids and replaces unsafe ones', () => {
    expect(requestIdFrom('trace-123_abc.9')).toBe('trace-123_abc.9');
    expect(requestIdFrom('bad id with spaces')).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestIdFrom('x'.repeat(65))).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestIdFrom(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
