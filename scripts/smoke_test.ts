const BASE_URL = process.env.QWEN_PROXY_BASE_URL || 'http://127.0.0.1:3260/api';
const MODEL = process.env.QWEN_PROXY_SMOKE_MODEL || 'auto';

async function requestJson(path: string, options: RequestInit = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.QWEN_PROXY_API_KEY ? { Authorization: `Bearer ${process.env.QWEN_PROXY_API_KEY}` } : {}),
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${path}: HTTP error ${response.status} ${text.slice(0, 500)}`);
  }

  return data;
}

async function main() {
  const status = await requestJson('/status');
  const models = await requestJson('/models');
  const modelIds = models.data.map((model: { id: string }) => model.id);

  console.log(`Accounts in status: ${status.accounts?.length ?? 0}`);
  console.log(`Models: ${modelIds.length}`);

  if (!modelIds.includes(MODEL)) {
    throw new Error(`Smoke model ${MODEL} is missing from /models`);
  }

  const completion = await requestJson('/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      messages: [
        { role: 'user', content: 'Reply with exactly one word: works' }
      ]
    })
  });

  const answer = completion.choices?.[0]?.message?.content || '';
  console.log(`${MODEL}: ${answer}`);
  console.log('Smoke check OK');
}

main().catch(error => {
  console.error(`Smoke check failed: ${error.message}`);
  process.exit(1);
});

export {};
