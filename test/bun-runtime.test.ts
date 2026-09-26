import { describe, expect, test } from 'bun:test';

import { DEFAULT_MODEL, HOST, PORT } from '../src/config.ts';

describe('Bun runtime compatibility', () => {
    test('loads ESM configuration', () => {
        expect(HOST).toBeString();
        expect(PORT).toBeGreaterThan(0);
        expect(DEFAULT_MODEL).toBeString();
    });
});
