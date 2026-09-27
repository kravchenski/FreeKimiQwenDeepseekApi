import { client, MODEL } from './client.ts';

const stream = await client.chat.completions.create({
    model: MODEL,
    stream: true,
    messages: [{ role: 'user', content: 'Write a short story about space in five sentences.' }],
});

for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0]?.delta.content ?? '');
}
process.stdout.write('\n');
