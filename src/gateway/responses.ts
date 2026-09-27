export type ToolRoute = {
    type: 'function' | 'custom';
    name: string;
    namespace?: string;
};

function toolKey(namespace: unknown, name: unknown) {
    return [namespace, name].filter(value => typeof value === 'string' && value).join('__');
}

function contentText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map(item => typeof item === 'string' ? item : item?.text || item?.output_text || '')
        .filter(Boolean)
        .join('\n');
}

export function flattenResponsesTools(tools: unknown) {
    const routes = new Map<string, ToolRoute>();
    if (!Array.isArray(tools)) return { tools: undefined, routes };

    const flattened = tools.flatMap((tool: any) => {
        if (tool?.type === 'namespace' && typeof tool.name === 'string' && Array.isArray(tool.tools)) {
            return tool.tools.flatMap((inner: any) => {
                if (typeof inner?.name !== 'string') return [];
                const name = toolKey(tool.name, inner.name);
                routes.set(name, { type: 'function', name: inner.name, namespace: tool.name });
                return [{
                    type: 'function',
                    function: {
                        name,
                        description: [tool.description, inner.description].filter(Boolean).join('\n\n'),
                        parameters: inner.parameters || { type: 'object', properties: {} }
                    }
                }];
            });
        }

        if (tool?.type === 'function' && typeof tool.name === 'string') {
            routes.set(tool.name, { type: 'function', name: tool.name });
            return [{
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description || '',
                    parameters: tool.parameters || { type: 'object', properties: {} }
                }
            }];
        }

        if (tool?.type === 'custom' && typeof tool.name === 'string') {
            routes.set(tool.name, { type: 'custom', name: tool.name });
            return [{
                type: 'function',
                function: {
                    name: tool.name,
                    description: `${tool.description || ''}\nPass the custom tool input in the "input" string property.`.trim(),
                    parameters: {
                        type: 'object',
                        properties: { input: { type: 'string' } },
                        required: ['input']
                    }
                }
            }];
        }

        return [];
    });

    return { tools: flattened.length ? flattened : undefined, routes };
}

export function responsesInputToMessages(body: Record<string, any>) {
    const messages: any[] = [];
    if (typeof body.instructions === 'string' && body.instructions) {
        messages.push({ role: 'system', content: body.instructions });
    }
    if (typeof body.input === 'string') {
        messages.push({ role: 'user', content: body.input });
        return messages;
    }
    if (!Array.isArray(body.input)) return messages;

    for (const item of body.input) {
        if (item?.type === 'message' || typeof item?.role === 'string') {
            const content = contentText(item.content);
            if (content) messages.push({ role: item.role || 'user', content });
        } else if (item?.type === 'function_call' || item?.type === 'custom_tool_call') {
            messages.push({
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: item.call_id,
                    type: 'function',
                    function: {
                        name: toolKey(item.namespace, item.name),
                        arguments: item.arguments || JSON.stringify({ input: item.input || '' })
                    }
                }]
            });
        } else if (item?.type === 'function_call_output' || item?.type === 'custom_tool_call_output') {
            messages.push({
                role: 'tool',
                tool_call_id: item.call_id,
                content: contentText(item.output)
            });
        }
    }
    return messages;
}

export function responsesToChatRequest(body: Record<string, any>) {
    const { tools, routes } = flattenResponsesTools(body.tools);
    return {
        routes,
        request: {
            model: body.model,
            messages: responsesInputToMessages(body),
            ...(tools ? { tools, tool_choice: 'auto' } : {}),
            ...(Number.isFinite(body.max_output_tokens) ? { max_tokens: body.max_output_tokens } : {}),
            stream: false
        }
    };
}

export function toolCallToOutputItem(call: Record<string, any>, index: number, routes: Map<string, ToolRoute>) {
    const route: ToolRoute = routes.get(call?.function?.name) || {
        type: 'function' as const,
        name: call?.function?.name
    };
    const callId = call.id || `call_${Date.now()}_${index}`;
    if (route.type === 'custom') {
        let input = call?.function?.arguments || '';
        try {
            input = JSON.parse(input)?.input ?? input;
        } catch {
        }
        return {
            type: 'custom_tool_call' as const,
            id: `ctc_${callId}`,
            call_id: callId,
            name: route.name,
            input,
            status: 'completed'
        };
    }
    return {
        type: 'function_call' as const,
        id: `fc_${callId}`,
        call_id: callId,
        name: route.name,
        ...(route.namespace ? { namespace: route.namespace } : {}),
        arguments: call?.function?.arguments || '{}',
        status: 'completed'
    };
}

export function reasoningOutputItem(id: string, text: string) {
    return { type: 'reasoning', id, summary: [{ type: 'summary_text', text }] };
}

export function chatResponseToResponses(body: Record<string, any>, routes: Map<string, ToolRoute>, includeReasoning = false) {
    const createdAt = Math.floor(Date.now() / 1000);
    const responseId = typeof body.id === 'string' ? body.id.replace(/^chatcmpl-/, 'resp_') : `resp_${Date.now()}`;
    const message = body?.choices?.[0]?.message || {};
    const output: any[] = [];

    if (includeReasoning && typeof message.reasoning_content === 'string' && message.reasoning_content) {
        output.push(reasoningOutputItem(`rs_${Date.now()}`, message.reasoning_content));
    }

    for (const [index, call] of (message.tool_calls || []).entries()) {
        output.push(toolCallToOutputItem(call, index, routes));
    }

    if (typeof message.content === 'string' && message.content) {
        output.push({
            type: 'message',
            id: `msg_${Date.now()}`,
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: message.content, annotations: [] }]
        });
    }

    return {
        id: responseId,
        object: 'response',
        created_at: createdAt,
        status: 'completed',
        model: body.model,
        output,
        parallel_tool_calls: true,
        usage: {
            input_tokens: body.usage?.prompt_tokens || 0,
            output_tokens: body.usage?.completion_tokens || 0,
            total_tokens: body.usage?.total_tokens || 0
        }
    };
}
