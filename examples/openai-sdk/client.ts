import OpenAI from 'openai';

export const client = new OpenAI({
    baseURL: process.env.FREEAPI_BASE_URL ?? 'http://localhost:3260/v1',
    apiKey: process.env.GATEWAY_API_KEY || 'not-needed',
});

export const MODEL = process.env.FREEAPI_MODEL ?? 'auto';
