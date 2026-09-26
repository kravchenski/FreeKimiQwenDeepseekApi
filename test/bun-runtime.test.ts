import { describe, expect, test } from 'bun:test';

import { loadConfig } from '../src/config.ts';

describe('Bun runtime compatibility', () => {
    test('loads ESM configuration', () => {
        const config = loadConfig({});
        expect(config.HOST).toBeString();
        expect(config.UNIFIED_PORT).toBeGreaterThan(0);
    });
});
