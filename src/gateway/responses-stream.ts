import { reasoningOutputItem, toolCallToOutputItem, type ToolRoute } from './responses.ts';

type OpenItem = { kind: 'reasoning' | 'message'; id: string; outputIndex: number; text: string };

export class ResponsesStreamTranslator {
    private sequence = 0;
    private readonly output: Array<Record<string, unknown>> = [];
    private current: OpenItem | null = null;
    private finished = false;
    private readonly createdAt = Math.floor(Date.now() / 1000);
    private itemCounter = 0;

    constructor(
        private readonly responseId: string,
        private readonly model: string,
        private readonly routes: Map<string, ToolRoute>,
        private readonly includeReasoning: boolean,
    ) {}

    start() {
        return [
            this.event('response.created', { response: this.snapshot('in_progress') }),
            this.event('response.in_progress', { response: this.snapshot('in_progress') }),
        ];
    }

    push(chunk: Record<string, any>): string[] {
        if (this.finished) return [];
        if (chunk.error) return this.fail(chunk.error);
        const choice = chunk.choices?.[0];
        if (!choice) return [];
        const delta = choice.delta ?? {};
        const out: string[] = [];
        if (this.includeReasoning && typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
            out.push(...this.append('reasoning', delta.reasoning_content));
        }
        if (typeof delta.content === 'string' && delta.content) out.push(...this.append('message', delta.content));
        for (const call of delta.tool_calls ?? []) {
            out.push(...this.close());
            const item = toolCallToOutputItem(call, this.output.length, this.routes);
            const outputIndex = this.output.length;
            this.output.push(item);
            const pending = item.type === 'custom_tool_call' ? { ...item, status: 'in_progress', input: '' } : { ...item, status: 'in_progress', arguments: '' };
            out.push(this.event('response.output_item.added', { output_index: outputIndex, item: pending }));
            if (item.type === 'custom_tool_call') {
                out.push(
                    this.event('response.custom_tool_call_input.delta', { item_id: item.id, output_index: outputIndex, delta: item.input }),
                    this.event('response.custom_tool_call_input.done', { item_id: item.id, output_index: outputIndex, input: item.input }),
                );
            } else {
                out.push(
                    this.event('response.function_call_arguments.delta', { item_id: item.id, output_index: outputIndex, delta: item.arguments }),
                    this.event('response.function_call_arguments.done', { item_id: item.id, output_index: outputIndex, arguments: item.arguments }),
                );
            }
            out.push(this.event('response.output_item.done', { output_index: outputIndex, item }));
        }
        if (choice.finish_reason) out.push(...this.finish());
        return out;
    }

    finish(): string[] {
        if (this.finished) return [];
        this.finished = true;
        return [...this.close(), this.event('response.completed', { response: this.snapshot('completed') })];
    }

    private fail(error: { message?: string; type?: string }): string[] {
        this.finished = true;
        const failed = { ...this.snapshot('failed'), error: { code: error.type ?? 'upstream_error', message: error.message ?? 'Upstream error' } };
        return [...this.close(), this.event('response.failed', { response: failed })];
    }

    private append(kind: OpenItem['kind'], text: string): string[] {
        const out = this.current?.kind === kind ? [] : [...this.close(), ...this.open(kind)];
        const current = this.current!;
        current.text += text;
        out.push(kind === 'reasoning'
            ? this.event('response.reasoning_summary_text.delta', { item_id: current.id, output_index: current.outputIndex, summary_index: 0, delta: text })
            : this.event('response.output_text.delta', { item_id: current.id, output_index: current.outputIndex, content_index: 0, delta: text }));
        return out;
    }

    private open(kind: OpenItem['kind']): string[] {
        const id = `${kind === 'reasoning' ? 'rs' : 'msg'}_${this.responseId.replace(/^resp_/, '')}_${this.itemCounter++}`;
        const outputIndex = this.output.length;
        this.output.push({});
        this.current = { kind, id, outputIndex, text: '' };
        if (kind === 'reasoning') {
            return [
                this.event('response.output_item.added', { output_index: outputIndex, item: { type: 'reasoning', id, summary: [] } }),
                this.event('response.reasoning_summary_part.added', { item_id: id, output_index: outputIndex, summary_index: 0, part: { type: 'summary_text', text: '' } }),
            ];
        }
        return [
            this.event('response.output_item.added', { output_index: outputIndex, item: { type: 'message', id, role: 'assistant', status: 'in_progress', content: [] } }),
            this.event('response.content_part.added', { item_id: id, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }),
        ];
    }

    private close(): string[] {
        const current = this.current;
        if (!current) return [];
        this.current = null;
        const { id, outputIndex, text } = current;
        if (current.kind === 'reasoning') {
            const item = reasoningOutputItem(id, text);
            this.output[outputIndex] = item;
            return [
                this.event('response.reasoning_summary_text.done', { item_id: id, output_index: outputIndex, summary_index: 0, text }),
                this.event('response.reasoning_summary_part.done', { item_id: id, output_index: outputIndex, summary_index: 0, part: { type: 'summary_text', text } }),
                this.event('response.output_item.done', { output_index: outputIndex, item }),
            ];
        }
        const part = { type: 'output_text', text, annotations: [] };
        const item = { type: 'message', id, role: 'assistant', status: 'completed', content: [part] };
        this.output[outputIndex] = item;
        return [
            this.event('response.output_text.done', { item_id: id, output_index: outputIndex, content_index: 0, text }),
            this.event('response.content_part.done', { item_id: id, output_index: outputIndex, content_index: 0, part }),
            this.event('response.output_item.done', { output_index: outputIndex, item }),
        ];
    }

    private snapshot(status: 'in_progress' | 'completed' | 'failed') {
        return {
            id: this.responseId,
            object: 'response',
            created_at: this.createdAt,
            status,
            model: this.model,
            output: status === 'in_progress' ? [] : this.output,
            parallel_tool_calls: true,
            usage: status === 'in_progress' ? null : { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        };
    }

    private event(type: string, data: Record<string, unknown>) {
        return `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.sequence++, ...data })}\n\n`;
    }
}
