import { serve } from 'bun';
import { Hono } from 'hono';
import crypto from 'crypto';

import { kimiCompletion } from './src/providers/kimi/client.ts';
import {
  conversationalShellText,
  parseToolCallJson,
  recoverBrokenBashToolCall,
  toolsToPrompt,
} from './src/api/routes.ts';

const app = new Hono();
const port = Number(process.env.KIMI_PORT || 3266);
const host = process.env.HOST || '0.0.0.0';
const models = ['kimi-k2.6', 'kimi-k2.6-thinking', 'kimi-k2.6-search', 'kimi-k2.6-thinking-search'];

function detectProvider(model: string) {
  if (model.startsWith('kimi-')) return 'kimi';
  return 'unknown';
}

function ownedBy(id: string) {
  if (id.startsWith('kimi-')) return 'kimi-zenmux';
  return 'unknown';
}

app.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'kimi-zenmux' });
});

app.get('/api/models', (c) => {
  return c.json({
    object: 'list',
    data: models.map(id => ({ id, object: 'model', created: 0, owned_by: ownedBy(id) }))
  });
});

app.get('/api/v1/models', (c) => {
  return c.json({
    object: 'list',
    data: models.map(id => ({ id, object: 'model', created: 0, owned_by: ownedBy(id) }))
  });
});

app.post('/api/chat/completions', async (c) => {
  try {
    const body = await c.req.json();
    const { messages, model = 'kimi-k2.6', stream = false, tools, functions } = body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return c.json({ error: { message: 'messages must be a non-empty array' } }, 400);
    }

    if (detectProvider(model) === 'unknown') {
      return c.json({ error: { message: `Unknown model: ${model}` } }, 400);
    }

    const combinedTools = tools || (Array.isArray(functions)
      ? functions.map((fn: Record<string, unknown>) => ({ type: 'function', function: fn }))
      : null);
    const toolPrompt = toolsToPrompt(combinedTools);
    const upstreamMessages = toolPrompt
      ? [{ role: 'system', content: toolPrompt }, ...messages]
      : messages;

    const result = await kimiCompletion({ messages: upstreamMessages, model });
    const id = `chatcmpl-${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
    const created = Math.floor(Date.now() / 1000);
    const captureToolCalls = Array.isArray(combinedTools) && combinedTools.length > 0;

    if (stream) {
      const encoder = new TextEncoder();
      const sse = new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`));

          const reader = result.response.body?.getReader();
          if (!reader) { controller.close(); return; }
          const decoder = new TextDecoder();
          let pending = '';

          while (true) {
            const { value, done } = await reader.read();
            pending += decoder.decode(value || new Uint8Array(), { stream: !done });
            const lines = pending.split('\n');
            pending = lines.pop() || '';
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const data = line.slice(6);
              if (data === '[DONE]') break;
              try {
                const parsed = JSON.parse(data);
                const choice = parsed.choices?.[0];
                if (choice?.delta) {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: choice.delta }] })}\n\n`));
                }
              } catch {}
            }
            if (done) break;
          }

          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }
      });

      return new Response(sse, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
      });
    }

    const responseText = await result.response.text();
    const parsed = JSON.parse(responseText);
    const content = parsed.choices?.[0]?.message?.content || '';

    if (captureToolCalls) {
      const recoveredShell = recoverBrokenBashToolCall(content);
      const conversationalText = recoveredShell ? conversationalShellText(recoveredShell.name, recoveredShell.arguments) : null;
      if (conversationalText) {
        return c.json({
          id, object: 'chat.completion', created, model,
          choices: [{ index: 0, message: { role: 'assistant', content: conversationalText }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        });
      }
      const toolCalls = parseToolCallJson(content, combinedTools);
      if (toolCalls?.length) {
        return c.json({
          id, object: 'chat.completion', created, model,
          choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: toolCalls.map(({ index: _i, ...t }) => t) }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        });
      }
    }

    return c.json({
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: { message } }, 502);
  }
});

app.post('/api/v1/chat/completions', async (c) => {
  return app.fetch(new Request(c.req.url.replace('/api/v1', '/api'), c.req));
});

serve({ fetch: app.fetch, port, hostname: host, idleTimeout: 255 });
console.log(`Kimi ZenMux proxy listening on http://${host}:${port}/api`);
console.log(`Models: ${models.join(', ')}`);
