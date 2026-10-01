function isImagePart(part: any): boolean {
  return part?.type === 'image_url' || part?.type === 'image';
}

function imageUrl(part: any): string | undefined {
  if (part?.type === 'image_url') {
    const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
    return typeof url === 'string' && url ? url : undefined;
  }
  const source = part?.source;
  if (source?.type === 'base64' && typeof source.data === 'string') {
    return `data:${typeof source.media_type === 'string' ? source.media_type : 'image/png'};base64,${source.data}`;
  }
  if (source?.type === 'url' && typeof source.url === 'string') return source.url;
  return undefined;
}

export function collectImageUrls(messages: Array<Record<string, any>>): string[] {
  const urls: string[] = [];
  for (const message of messages ?? []) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (!isImagePart(part)) continue;
      const url = imageUrl(part);
      if (url) urls.push(url);
    }
  }
  return urls;
}

export function stripImages(messages: Array<Record<string, any>>, supported: boolean): Array<Record<string, any>> {
  const marker = supported ? '[image]' : '[image omitted: this model cannot process images]';
  return (messages ?? []).map(message => {
    const content = message?.content;
    if (!Array.isArray(content)) return message;
    const parts: string[] = [];
    let hadImage = false;
    for (const part of content) {
      if (isImagePart(part)) {
        hadImage = true;
        parts.push(marker);
      } else if (typeof part?.text === 'string') parts.push(part.text);
      else parts.push(typeof part === 'string' ? part : JSON.stringify(part ?? ''));
    }
    if (!hadImage) return message;
    return { ...message, content: parts.join('\n') };
  });
}

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
