const BASE = process.env.TEST_BASE_URL || 'http://localhost:3260/v1';

const models = [
  'deepseek-default',
  'deepseek-reasoner',
  'deepseek-expert',
  'deepseek-search',
  'qwen-max-latest',
  'qwen-plus',
  'qwen3-max',
  'qwen3-plus',
  'qwen3-coder-plus',
  'qwen3-omni-flash',
  'qwen3.5-flash',
  'qwen-turbo-latest',
  'qwen2.5-coder-32b-instruct',
  'qwq-32b',
];

const TIMEOUT = 65_000;

async function testModel(model: string): Promise<{ model: string; status: string; error?: string; time?: number }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    const res = await fetch(`${BASE}/chat/completions`, {
      signal: controller.signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{ role: 'user', content: 'Say exactly one word: OK' }],
      }),
    });
    clearTimeout(timer);
    const elapsed = Date.now() - start;
    const data = await res.json();
    if (!res.ok) {
      return { model, status: 'ERROR', error: `HTTP ${res.status}: ${data.error?.message || JSON.stringify(data).slice(0, 200)}`, time: elapsed };
    }
    const content = data.choices?.[0]?.message?.content || '';
    if (content.trim()) {
      return { model, status: 'OK', time: elapsed };
    }
    return { model, status: 'EMPTY', error: `empty content: ${JSON.stringify(data).slice(0, 200)}`, time: elapsed };
  } catch (e) {
    return { model, status: 'FAIL', error: String(e) };
  }
}

async function main() {
  console.log(`\n  Testing ${models.length} models against ${BASE}\n`);
  const results: { model: string; status: string; error?: string; time?: number }[] = [];

  for (const model of models) {
    process.stdout.write(`  ${model.padEnd(38)} ... `);
    const result = await testModel(model);
    results.push(result);
    const icon = result.status === 'OK' ? '✓' : result.status === 'EMPTY' ? '⚠' : '✗';
    const time = result.time ? `${(result.time / 1000).toFixed(1)}s` : '';
    console.log(`${icon} ${result.status}${time ? ` (${time})` : ''}${result.error ? ` — ${result.error}` : ''}`);
  }

  const ok = results.filter(r => r.status === 'OK').length;
  const empty = results.filter(r => r.status === 'EMPTY').length;
  const failed = results.filter(r => r.status !== 'OK' && r.status !== 'EMPTY').length;

  console.log(`\n  ─────────────────────────────────────`);
  console.log(`  Всего: ${results.length}  |  OK: ${ok}  |  Пусто: ${empty}  |  Ошибок: ${failed}`);
  console.log();
}

main().catch(console.error);
