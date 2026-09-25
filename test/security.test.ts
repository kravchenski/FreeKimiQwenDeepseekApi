import { describe, expect, test } from 'bun:test';

import { isValidChatId } from '../src/api/chatHistory.ts';
import { bearerToken, isForwardableResponseHeader, tokenMatches } from '../src/gateway/security.ts';

describe('security boundaries', () => {
    test('rejects path traversal chat ids', () => {
        expect(isValidChatId('../../outside')).toBeFalse();
        expect(isValidChatId('..%2F..%2Foutside')).toBeFalse();
        expect(isValidChatId('valid_chat-id_123')).toBeTrue();
    });

    test('protects the gateway with timing-safe bearer checks', () => {
        expect(bearerToken('Bearer local-secret')).toBe('local-secret');
        expect(bearerToken('Basic local-secret')).toBeNull();
        expect(tokenMatches('local-secret', 'local-secret')).toBeTrue();
        expect(tokenMatches('wrong', 'local-secret')).toBeFalse();
        expect(tokenMatches(null, undefined)).toBeTrue();
    });

    test('does not forward hop-by-hop upstream headers', () => {
        expect(isForwardableResponseHeader('content-type')).toBeTrue();
        expect(isForwardableResponseHeader('transfer-encoding')).toBeFalse();
        expect(isForwardableResponseHeader('Content-Length')).toBeFalse();
    });
});

describe('tokenMatches edge cases', () => {
    test('rejects tokens of different length and prefixes', () => {
        expect(tokenMatches('local', 'local-secret')).toBeFalse();
        expect(tokenMatches('local-secret-extra', 'local-secret')).toBeFalse();
        expect(tokenMatches('', 'local-secret')).toBeFalse();
    });

    test('compares multibyte tokens by bytes', () => {
        expect(tokenMatches('key-✓-€', 'key-✓-€')).toBeTrue();
        expect(tokenMatches('key-x-€', 'key-✓-€')).toBeFalse();
    });
});
