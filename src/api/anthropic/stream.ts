import { anthropicError } from './messages.ts';

type BlockKind = 'thinking' | 'text' | 'tool_use';

const ERROR_STATUS: Record<string, number> = {
  rate_limit_exceeded: 429,
  insufficient_quota: 429,
  provider_unavailable: 503,
};

function event(type: string, data: Record<string, unknown>) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

export class AnthropicStreamTranslator {
  private index = -1;
  private open: BlockKind | null = null;
  private stopReason: 'end_turn' | 'tool_use' = 'end_turn';
  private outputChars = 0;
  private finished = false;

  constructor(
    private readonly id: string,
    private readonly model: string,
    private readonly includeThinking: boolean,
  ) {}

  start() {
    return [event('message_start', {
      message: {
        id: this.id,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })];
  }

  push(chunk: Record<string, any>): string[] {
    if (this.finished) return [];
    if (chunk.error) return this.fail(chunk.error);
    const choice = chunk.choices?.[0];
    if (!choice) return [];
    const delta = choice.delta ?? {};
    const out: string[] = [];
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content && this.includeThinking) {
      out.push(...this.ensure('thinking'), event('content_block_delta', { index: this.index, delta: { type: 'thinking_delta', thinking: delta.reasoning_content } }));
    }
    if (typeof delta.content === 'string' && delta.content) {
      this.outputChars += delta.content.length;
      out.push(...this.ensure('text'), event('content_block_delta', { index: this.index, delta: { type: 'text_delta', text: delta.content } }));
    }
    for (const call of delta.tool_calls ?? []) {
      out.push(...this.close());
      this.index += 1;
      this.open = 'tool_use';
      this.stopReason = 'tool_use';
      const args = call.function?.arguments ?? '{}';
      this.outputChars += args.length;
      out.push(
        event('content_block_start', { index: this.index, content_block: { type: 'tool_use', id: call.id, name: call.function?.name, input: {} } }),
        event('content_block_delta', { index: this.index, delta: { type: 'input_json_delta', partial_json: args } }),
      );
    }
    if (choice.finish_reason) out.push(...this.finish());
    return out;
  }

  finish(): string[] {
    if (this.finished) return [];
    this.finished = true;
    return [
      ...this.close(),
      event('message_delta', {
        delta: { stop_reason: this.stopReason, stop_sequence: null },
        usage: { output_tokens: Math.ceil(this.outputChars / 4) },
      }),
      event('message_stop', {}),
    ];
  }

  private fail(error: { message?: string; type?: string }): string[] {
    this.finished = true;
    const status = ERROR_STATUS[error.type ?? ''] ?? 502;
    const payload = anthropicError(status, error.message ?? 'Upstream error');
    return [...this.close(), `event: error\ndata: ${JSON.stringify(payload)}\n\n`];
  }

  private ensure(kind: 'thinking' | 'text'): string[] {
    if (this.open === kind) return [];
    const out = this.close();
    this.index += 1;
    this.open = kind;
    const block = kind === 'thinking' ? { type: 'thinking', thinking: '', signature: '' } : { type: 'text', text: '' };
    out.push(event('content_block_start', { index: this.index, content_block: block }));
    return out;
  }

  private close(): string[] {
    if (this.open === null) return [];
    this.open = null;
    return [event('content_block_stop', { index: this.index })];
  }
}
