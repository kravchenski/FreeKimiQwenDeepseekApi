import { describe, expect, test } from 'bun:test';
import { loadConfig, parseEnv } from '../src/config.ts';

describe('parseEnv', () => {
    test('applies defaults for missing and blank values', () => {
        expect(parseEnv({ UNIFIED_PORT: '', GATEWAY_API_KEY: '  ' })).toEqual({
            UNIFIED_PORT: 3260,
            HOST: '0.0.0.0',
            SESSION_DIR: 'session',
            GATEWAY_API_KEY: undefined,
            AUTO_MODELS: undefined,
            AUTO_FIRST_CHUNK_TIMEOUT_MS: 60_000,
            MODEL_REFRESH_MINUTES: 360,
        });
    });

    test('coerces provided values', () => {
        const env = parseEnv({ UNIFIED_PORT: '8080', HOST: '127.0.0.1', GATEWAY_API_KEY: 'secret', AUTO_MODELS: 'auto-a,auto-b' });
        expect(env).toMatchObject({ UNIFIED_PORT: 8080, HOST: '127.0.0.1', GATEWAY_API_KEY: 'secret', AUTO_MODELS: 'auto-a,auto-b' });
    });

    test('rejects invalid values', () => {
        expect(() => parseEnv({ UNIFIED_PORT: 'abc' })).toThrow('UNIFIED_PORT');
        expect(() => parseEnv({ UNIFIED_PORT: '70000' })).toThrow('UNIFIED_PORT');
        expect(() => parseEnv({ MODEL_REFRESH_MINUTES: '-1' })).toThrow('MODEL_REFRESH_MINUTES');
    });

    test('loads from the given environment at call time', () => {
        expect(loadConfig({ UNIFIED_PORT: '4000' }).UNIFIED_PORT).toBe(4000);
    });
});
