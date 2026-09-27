import type OpenAI from 'openai';

import { client, MODEL } from './client.ts';

const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'user', content: 'My name is Alex. Remember it.' },
];

const first = await client.chat.completions.create({ model: MODEL, messages });
const firstReply = first.choices[0]?.message.content ?? '';
console.log('Assistant:', firstReply);

messages.push({ role: 'assistant', content: firstReply }, { role: 'user', content: 'What is my name?' });
const second = await client.chat.completions.create({ model: MODEL, messages });
console.log('Assistant:', second.choices[0]?.message.content);
