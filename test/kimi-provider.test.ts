import { describe, expect, test } from 'bun:test';

import {
    isEmptyToolCallResponse,
    parseKimiEvent
} from '../src/providers/kimi/client.ts';
import { hasValidKimiAccounts } from '../src/providers/kimi/accounts.ts';

describe('Kimi provider (ZenMux)', () => {
    test('parses SSE Kimi events', () => {
        expect(parseKimiEvent('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hello' } }] })))
            .toEqual({ content: 'hello' });
        expect(parseKimiEvent('data: ' + JSON.stringify({ choices: [{ delta: { content: '' }, finish_reason: 'stop' }] })))
            .toEqual({ done: true });
        expect(parseKimiEvent('data: ' + JSON.stringify({}))).toBeNull();
        expect(parseKimiEvent('data: [DONE]')).toEqual({ done: true });
        expect(parseKimiEvent('nope')).toBeNull();
    });

    test('detects empty simulated tool-call responses', () => {
        expect(isEmptyToolCallResponse('{"tool_calls":[]}')).toBeTrue();
        expect(isEmptyToolCallResponse('{"tool_calls":[{"name":"read"}]}')).toBeFalse();
    });

    test('can inspect Kimi account availability without environment setup', () => {
        expect(typeof hasValidKimiAccounts()).toBe('boolean');
    });
});
