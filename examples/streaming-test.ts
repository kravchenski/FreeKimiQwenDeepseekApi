const BASE_URL = process.env.FREEAPI_BASE_URL ?? 'http://localhost:3260/v1';

const startedAt = Date.now();
let firstChunkAt: number | null = null;
let chunks = 0;

const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        ...(process.env.GATEWAY_API_KEY ? { Authorization: `Bearer ${process.env.GATEWAY_API_KEY}` } : {}),
    },
    body: JSON.stringify({
        model: process.env.FREEAPI_MODEL ?? 'auto',
        stream: true,
        messages: [{ role: 'user', content: 'Tell a short story about space in five to seven sentences.' }],
    }),
});

if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}: ${await response.text()}`);

const decoder = new TextDecoder();
let buffer = '';
for await (const part of response.body) {
    buffer += decoder.decode(part, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content;
        if (!delta) continue;
        firstChunkAt ??= Date.now();
        chunks += 1;
        process.stdout.write(delta);
    }
}

console.log(`\n\nChunks: ${chunks}, first chunk after ${(firstChunkAt ?? Date.now()) - startedAt} ms, total ${Date.now() - startedAt} ms`);

export {};
