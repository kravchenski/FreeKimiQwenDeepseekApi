const BASE_URL = process.env.FREEAPI_BASE_URL ?? 'http://localhost:3260/v1';

const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        ...(process.env.GATEWAY_API_KEY ? { Authorization: `Bearer ${process.env.GATEWAY_API_KEY}` } : {}),
    },
    body: JSON.stringify({
        model: process.env.FREEAPI_MODEL ?? 'auto',
        messages: [{ role: 'user', content: 'Explain in simple words what artificial intelligence is.' }],
    }),
});

if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);

const result = await response.json();
console.log(result.choices[0].message.content);
console.log('\nServed by:', response.headers.get('x-gateway-route'));

export {};
