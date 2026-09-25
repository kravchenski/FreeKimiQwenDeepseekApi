import { describe, expect, test } from 'bun:test';

import { conversationKey, isEmptyToolCallResponse, messagesToPrompt, parseDeepSeekEvent } from '../src/providers/deepseek/client.ts';
import { validateDeepSeekPowSolver } from '../src/providers/deepseek/pow.ts';
import { hasValidDeepSeekAccounts } from '../src/providers/deepseek/accounts.ts';
import { isDeepSeekUrl } from '../src/providers/deepseek/url.ts';

describe('DeepSeek web provider', () => {
    test('keeps a stable conversation key during a pi tool loop', () => {
        const initial = [{ role: 'user', content: 'build a feature' }];
        const continued = [
            ...initial,
            { role: 'assistant', tool_calls: [{ function: { name: 'read' } }] },
            { role: 'tool', content: 'result' }
        ];

        expect(conversationKey(continued)).toBe(conversationKey(initial));
    });

    test('folds tool results into the DeepSeek prompt', () => {
        expect(messagesToPrompt([
            { role: 'user', content: 'inspect it' },
            { role: 'tool', name: 'read', content: 'file contents' }
        ])).toContain('Tool result (read): file contents');
    });

    test('parses current DeepSeek fragment events', () => {
        const state = { phase: 'content' as const, fragment: undefined as string | undefined };
        parseDeepSeekEvent('data: {"p":"response/fragments/-1/type","v":"THINK"}', state);
        expect(parseDeepSeekEvent('data: {"p":"response/fragments/-1/content","v":"reason"}', state))
            .toEqual({ reasoning: 'reason' });
        parseDeepSeekEvent('data: {"p":"response/fragments/-1/type","v":"RESPONSE"}', state);
        expect(parseDeepSeekEvent('data: {"p":"response/fragments/-1/content","v":"answer"}', state))
            .toEqual({ content: 'answer' });
        expect(parseDeepSeekEvent('data: {"p":"response/status","v":"FINISHED"}', state))
            .toEqual({ done: true });
    });

    test('preserves initial content from DeepSeek snapshot events', () => {
        const state = { phase: 'content' as const, contentSnapshot: '' };

        expect(parseDeepSeekEvent('data: {"v":{"response":{"content":"При"}}}', state))
            .toEqual({ content: 'При' });
        expect(parseDeepSeekEvent('data: {"v":"вет!"}', state))
            .toEqual({ content: 'вет!' });
    });

    test('detects empty simulated tool-call responses for conversational retry', () => {
        expect(isEmptyToolCallResponse('{"tool_calls":[]}')).toBeTrue();
        expect(isEmptyToolCallResponse('```json\n{"tool_calls": []}\n```')).toBeTrue();
        expect(isEmptyToolCallResponse('{"tool_calls":[{"name":"read"}]}')).toBeFalse();
    });

    test('loads the bundled DeepSeek PoW solver', async () => {
        expect(await validateDeepSeekPowSolver()).toBeTrue();
    });

    test('can inspect DeepSeek account availability without environment setup', () => {
        expect(typeof hasValidDeepSeekAccounts()).toBe('boolean');
    });
});

describe('isDeepSeekUrl', () => {
    test('accepts DeepSeek hosts over https', () => {
        expect(isDeepSeekUrl('https://chat.deepseek.com/sign_in')).toBeTrue();
        expect(isDeepSeekUrl('https://deepseek.com/')).toBeTrue();
    });

    test('rejects look-alike and non-https urls', () => {
        expect(isDeepSeekUrl('https://evil.test/?next=deepseek.com')).toBeFalse();
        expect(isDeepSeekUrl('https://deepseek.com.evil.test/')).toBeFalse();
        expect(isDeepSeekUrl('https://evildeepseek.com/')).toBeFalse();
        expect(isDeepSeekUrl('http://chat.deepseek.com/')).toBeFalse();
        expect(isDeepSeekUrl('about:blank')).toBeFalse();
    });
});
