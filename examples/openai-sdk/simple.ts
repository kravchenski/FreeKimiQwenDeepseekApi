import { client, MODEL } from './client.ts';

const completion = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: 'Explain in simple words what artificial intelligence is.' }],
});

console.log(completion.choices[0]?.message.content);
