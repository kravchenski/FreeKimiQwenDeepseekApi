import { describe, expect, test } from 'bun:test';

import {
    chatResponseToResponses,
    responsesSseEvents,
    flattenResponsesTools,
    responsesInputToMessages,
    responsesToChatRequest
} from '../src/gateway/responses.ts';

describe('Responses API gateway bridge', () => {
    test('flattens namespaces and restores them on function calls', () => {
        const sourceTools = [{
            type: 'namespace',
            name: 'mcp__playwright',
            tools: [{
                type: 'function',
                name: 'browser_navigate',
                parameters: { type: 'object', properties: { url: { type: 'string' } } }
            }]
        }];
        const { tools, routes } = flattenResponsesTools(sourceTools);

        expect(tools?.[0].function.name).toBe('mcp__playwright__browser_navigate');
        const response = chatResponseToResponses({
            id: 'chatcmpl-test',
            model: 'qwen3.7-max',
            choices: [{
                message: {
                    tool_calls: [{
                        id: 'call_test',
                        function: {
                            name: 'mcp__playwright__browser_navigate',
                            arguments: '{"url":"https://example.com"}'
                        }
                    }]
                }
            }]
        }, routes);

        expect(response.output[0]).toMatchObject({
            type: 'function_call',
            name: 'browser_navigate',
            namespace: 'mcp__playwright',
            arguments: '{"url":"https://example.com"}'
        });
    });

    test('converts custom tools and their previous outputs', () => {
        const { request, routes } = responsesToChatRequest({
            model: 'qwen3.7-max',
            instructions: 'Use tools.',
            input: [
                { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Patch it' }] },
                { type: 'custom_tool_call', call_id: 'call_patch', name: 'apply_patch', input: '*** Begin Patch' },
                { type: 'custom_tool_call_output', call_id: 'call_patch', output: 'Done' }
            ],
            tools: [{ type: 'custom', name: 'apply_patch', description: 'Apply a patch' }]
        });

        expect(request.tools?.[0].function.parameters.required).toEqual(['input']);
        expect(responsesInputToMessages({
            input: [{ type: 'function_call_output', call_id: 'call_1', output: 'ok' }]
        })[0]).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: 'ok' });

        const response = chatResponseToResponses({
            choices: [{
                message: {
                    tool_calls: [{
                        id: 'call_patch',
                        function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch"}' }
                    }]
                }
            }]
        }, routes);
        expect(response.output[0]).toMatchObject({
            type: 'custom_tool_call',
            name: 'apply_patch',
            input: '*** Begin Patch'
        });
    });
});

describe('responsesSseEvents', () => {
    test('emits typed events with text and function call deltas in order', () => {
        const events = responsesSseEvents({
            id: 'resp_1',
            object: 'response',
            status: 'completed',
            output: [
                { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'read', arguments: '{"path":"a"}', status: 'completed' },
                { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hi', annotations: [] }] },
            ],
        }).map(chunk => JSON.parse(chunk.split('\ndata: ')[1]!));

        expect(events.map(event => event.type)).toEqual([
            'response.created',
            'response.in_progress',
            'response.output_item.added',
            'response.function_call_arguments.delta',
            'response.function_call_arguments.done',
            'response.output_item.done',
            'response.output_item.added',
            'response.content_part.added',
            'response.output_text.delta',
            'response.output_text.done',
            'response.content_part.done',
            'response.output_item.done',
            'response.completed',
        ]);
        expect(events.map(event => event.sequence_number)).toEqual(events.map((_, index) => index));
        expect(events.find(event => event.type === 'response.output_text.delta')).toMatchObject({ item_id: 'msg_1', delta: 'Hi' });
        expect(events[0].response).toMatchObject({ status: 'in_progress', output: [] });
    });
});

