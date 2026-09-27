export function messagesToPrompt(messages: Array<Record<string, any>>) {
  return messages.map(message => {
    const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
    if (message.role === 'tool') return `Tool result (${message.name || message.tool_call_id || 'tool'}): ${content}`;
    if (message.role === 'assistant' && message.tool_calls) {
      return `Assistant tool calls: ${JSON.stringify(message.tool_calls)}\n${content}`;
    }
    return `${message.role || 'user'}: ${content}`;
  }).join('\n\n');
}
