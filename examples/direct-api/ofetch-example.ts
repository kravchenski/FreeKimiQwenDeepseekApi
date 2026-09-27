import { ofetch } from 'ofetch';

const api = ofetch.create({
    baseURL: process.env.FREEAPI_BASE_URL ?? 'http://localhost:3260/v1',
    headers: process.env.GATEWAY_API_KEY ? { Authorization: `Bearer ${process.env.GATEWAY_API_KEY}` } : {},
});
const model = process.env.FREEAPI_MODEL ?? 'auto';
const conversationId = crypto.randomUUID();

const messages = [{ role: 'user', content: 'Suggest a name for a coffee shop.' }];
const first = await api('/chat/completions', { method: 'POST', body: { model, messages, conversation_id: conversationId } });
console.log('First answer:', first.choices[0].message.content);

messages.push(
    { role: 'assistant', content: first.choices[0].message.content },
    { role: 'user', content: 'Now make it shorter.' },
);
const followUp = await api('/chat/completions', { method: 'POST', body: { model, messages, conversation_id: conversationId } });
console.log('Follow-up:', followUp.choices[0].message.content);
