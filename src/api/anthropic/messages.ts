type Block = Record<string, any>;

function blocks(content: unknown): Block[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

function text(content: unknown) {
  return blocks(content).filter(block => block.type === 'text').map(block => block.text).join('\n');
}

function imagePart(block: Block) {
  const source = block.source ?? {};
  const url = source.type === 'base64' ? `data:${source.media_type};base64,${source.data}` : source.url;
  return url ? { type: 'image_url', image_url: { url } } : null;
}

function userMessages(content: unknown) {
  const messages: Block[] = [];
  const parts: Block[] = [];
  for (const block of blocks(content)) {
    if (block.type === 'tool_result') {
      messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: typeof block.content === 'string' ? block.content : text(block.content) });
    } else if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      const part = imagePart(block);
      if (part) parts.push(part);
    }
  }
  if (parts.length) {
    const onlyText = parts.every(part => part.type === 'text');
    messages.push({ role: 'user', content: onlyText ? parts.map(part => part.text).join('\n') : parts });
  }
  return messages;
}

function assistantMessage(content: unknown) {
  const toolCalls = blocks(content)
    .filter(block => block.type === 'tool_use')
    .map(block => ({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } }));
  return { role: 'assistant', content: text(content) || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
}

export function anthropicToChatRequest(body: Record<string, any>) {
  const system = typeof body.system === 'string' ? body.system : text(body.system);
  const messages: Block[] = system ? [{ role: 'system', content: system }] : [];
  for (const message of body.messages ?? []) {
    if (message.role === 'assistant') messages.push(assistantMessage(message.content));
    else messages.push(...userMessages(message.content));
  }
  const tools = Array.isArray(body.tools)
    ? body.tools
      .filter((tool: Block) => tool.name && tool.input_schema)
      .map((tool: Block) => ({ type: 'function', function: { name: tool.name, description: tool.description ?? '', parameters: tool.input_schema } }))
    : [];
  const model = typeof body.model === 'string' && !body.model.startsWith('claude') ? body.model : 'auto';
  return {
    model,
    messages,
    ...(tools.length ? { tools } : {}),
    ...(Number.isFinite(body.max_tokens) ? { max_tokens: body.max_tokens } : {}),
    stream: false,
  };
}

function parseArguments(value: unknown) {
  try {
    return typeof value === 'string' ? JSON.parse(value) : value ?? {};
  } catch {
    return { raw: value };
  }
}

export function chatToAnthropicMessage(chat: Record<string, any>, requestedModel: string) {
  const message = chat?.choices?.[0]?.message ?? {};
  const content: Block[] = [];
  if (typeof message.content === 'string' && message.content) content.push({ type: 'text', text: message.content });
  for (const call of message.tool_calls ?? []) {
    content.push({ type: 'tool_use', id: call.id, name: call.function?.name, input: parseArguments(call.function?.arguments) });
  }
  return {
    id: typeof chat.id === 'string' ? chat.id.replace(/^chatcmpl-/, 'msg_') : `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: message.tool_calls?.length ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: chat.usage?.prompt_tokens ?? 0, output_tokens: chat.usage?.completion_tokens ?? 0 },
  };
}

export function anthropicSseEvents(message: ReturnType<typeof chatToAnthropicMessage>) {
  const events: string[] = [];
  const send = (type: string, data: Record<string, unknown>) => events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send('message_start', { message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } });
  message.content.forEach((block, index) => {
    if (block.type === 'text') {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
    } else {
      send('content_block_start', { index, content_block: { ...block, input: {} } });
      send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    send('content_block_stop', { index });
  });
  send('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage.output_tokens } });
  send('message_stop', {});
  return events;
}

const ERROR_TYPES: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  503: 'overloaded_error',
};

export function anthropicError(status: number, message: string) {
  return { type: 'error', error: { type: ERROR_TYPES[status] ?? 'api_error', message } };
}

export function estimateInputTokens(body: Record<string, any>) {
  return Math.ceil(JSON.stringify({ system: body.system, messages: body.messages, tools: body.tools }).length / 4);
}
