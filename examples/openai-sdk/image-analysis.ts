import { client } from './client.ts';

const IMAGE_URL = 'https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png';

const completion = await client.chat.completions.create({
    model: process.env.FREEAPI_MODEL ?? 'meta/llama-3.2-11b-vision-instruct',
    messages: [{
        role: 'user',
        content: [
            { type: 'text', text: 'Describe this image in detail.' },
            { type: 'image_url', image_url: { url: IMAGE_URL } },
        ],
    }],
});

console.log(completion.choices[0]?.message.content);
