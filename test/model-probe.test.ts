import { describe, expect, test } from 'bun:test';

import { formatReport, listGatewayModels, probeModel, probeModels, summarizeError } from '../src/cli/model-probe.ts';

const delta = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

function gateway(behavior: Record<string, 'ok' | 'missing' | 'hang' | 'empty'>) {
  const bodies: unknown[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/models')) {
      return Response.json({ data: [{ id: 'auto', owned_by: 'gateway' }, ...Object.keys(behavior).map(id => ({ id, owned_by: 'nvidia' }))] });
    }
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    const mode = behavior[body.model];
    if (mode === 'missing') return Response.json({ error: { message: 'Not found for account' } }, { status: 404 });
    if (mode === 'empty') return new Response('data: [DONE]\n\n');
    if (mode === 'hang') {
      return new Response(new ReadableStream({
        start(controller) {
          init.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
        },
      }));
    }
    return new Response(delta('pong') + 'data: [DONE]\n\n');
  }) as unknown as typeof fetch;
  return { fetchFn, bodies };
}

describe('model probe', () => {
  test('lists gateway models without auto', async () => {
    const { fetchFn } = gateway({ a: 'ok' });
    expect(await listGatewayModels({ baseUrl: 'http://gw/v1', timeoutMs: 100, fetch: fetchFn })).toEqual([{ id: 'a', ownedBy: 'nvidia' }]);
  });

  test('marks a model working after its first streamed chunk', async () => {
    const { fetchFn, bodies } = gateway({ a: 'ok' });
    const result = await probeModel({ id: 'a', ownedBy: 'nvidia' }, { baseUrl: 'http://gw/v1', timeoutMs: 1000, fetch: fetchFn });
    expect(result.ok).toBeTrue();
    expect(result.firstChunkMs).toBeGreaterThanOrEqual(0);
    expect(bodies[0]).toMatchObject({ model: 'a', stream: true });
  });

  test('reports missing, empty and hanging models as not working', async () => {
    const { fetchFn } = gateway({ gone: 'missing', silent: 'empty', slow: 'hang' });
    const options = { baseUrl: 'http://gw/v1', timeoutMs: 30, fetch: fetchFn };
    expect((await probeModel({ id: 'gone', ownedBy: 'nvidia' }, options)).error).toBe('404 not available for this key');
    expect((await probeModel({ id: 'silent', ownedBy: 'nvidia' }, options)).error).toBe('empty response');
    expect((await probeModel({ id: 'slow', ownedBy: 'nvidia' }, options)).error).toBe('no answer within 30 ms');
  });

  test('probes every model and prints working ones fastest first with a comma-separated list', async () => {
    const { fetchFn } = gateway({ a: 'ok', b: 'missing', c: 'ok' });
    const seen: string[] = [];
    const results = await probeModels(
      ['a', 'b', 'c'].map(id => ({ id, ownedBy: 'nvidia' })),
      { baseUrl: 'http://gw/v1', timeoutMs: 1000, fetch: fetchFn, concurrency: 2 },
      result => seen.push(result.model),
    );
    expect(seen.sort()).toEqual(['a', 'b', 'c']);
    const report = formatReport([
      { model: 'a', ownedBy: 'nvidia', ok: true, firstChunkMs: 2000 },
      { model: 'c', ownedBy: 'nvidia', ok: true, firstChunkMs: 500 },
      ...results.filter(result => !result.ok),
    ]);
    expect(report).toContain('Working models (2/3)');
    expect(report.indexOf('✓ c')).toBeLessThan(report.indexOf('✓ a'));
    expect(report).toContain('✗ b');
    expect(report.trimEnd().endsWith('c,a')).toBeTrue();
  });

  test('shortens upstream errors without account details', () => {
    const body = JSON.stringify({ error: { message: 'NVIDIA completion failed: 404 {"detail":"Function \'f\': Not found for account \'secret\'"}' } });
    expect(summarizeError(404, body)).toBe('404 not available for this key');
    expect(summarizeError(502, JSON.stringify({ error: { message: 'NVIDIA completion failed: 400 maximum context length is 8192' } }))).toBe('502 context too small');
    expect(summarizeError(502, JSON.stringify({ error: { message: 'NVIDIA completion failed: 500 boom\n  x' } }))).toBe('502 500 boom x');
  });
});
