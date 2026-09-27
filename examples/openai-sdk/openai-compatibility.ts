import { client, MODEL } from './client.ts';

const models = await client.models.list();
console.log('Models:', models.data.map(model => model.id).join(', '));

const completion = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
});
console.log('Chat completion:', completion.choices[0]?.message.content);

const response = await client.responses.create({ model: MODEL, input: 'Reply with exactly: pong' });
console.log('Responses API:', response.output_text);
