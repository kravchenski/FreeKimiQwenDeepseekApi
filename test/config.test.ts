import { describe, expect, test } from 'bun:test';
import { parseEnv } from '../src/config.ts';

describe('parseEnv', () => {
    test('applies defaults for missing and blank values', () => {
        const env = parseEnv({ PORT: '', PAGE_POOL_SIZE: undefined });
        expect(env.PORT).toBe(3264);
        expect(env.PAGE_POOL_SIZE).toBe(3);
        expect(env.LOG_LEVEL).toBe('info');
        expect(env.CORS_ALLOWED_ORIGINS).toEqual([]);
        expect(env.ALLOW_UNSCOPED_SESSION_CHAT_RESTORE).toBe(false);
    });

    test('coerces provided values', () => {
        const env = parseEnv({
            PORT: '8080',
            CORS_ALLOWED_ORIGINS: 'http://a.test, http://b.test',
            ALLOW_UNSCOPED_SESSION_CHAT_RESTORE: 'yes',
        });
        expect(env.PORT).toBe(8080);
        expect(env.CORS_ALLOWED_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
        expect(env.ALLOW_UNSCOPED_SESSION_CHAT_RESTORE).toBe(true);
    });

    test('rejects invalid values', () => {
        expect(() => parseEnv({ PORT: 'abc' })).toThrow('PORT');
        expect(() => parseEnv({ PORT: '70000' })).toThrow('PORT');
        expect(() => parseEnv({ QWEN_BASE_URL: 'not a url' })).toThrow('QWEN_BASE_URL');
        expect(() => parseEnv({ LOG_LEVEL: 'verbose' })).toThrow('LOG_LEVEL');
    });
});
