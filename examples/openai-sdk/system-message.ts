import { client, MODEL } from './client.ts';

const completion = await client.chat.completions.create({
    model: MODEL,
    messages: [
        { role: 'system', content: 'You are a concise assistant. Answer in at most two sentences.' },
        { role: 'user', content: 'Why is the sky blue?' },
    ],
});

console.log(completion.choices[0]?.message.content);
