import { describe, expect, test } from 'bun:test';
import { browserCandidates, findBrowserExecutable } from '../src/platform/browserExecutable.ts';
import { parseStartupArgs } from '../src/cli/startup.ts';

describe('cross-platform runtime', () => {
    test('discovers standard browser locations on each supported OS', () => {
        expect(browserCandidates('linux').some(path => path.includes('chromium'))).toBeTrue();
        expect(browserCandidates('darwin').some(path => path.includes('Google Chrome.app'))).toBeTrue();
        expect(browserCandidates('win32', { PROGRAMFILES: 'C:\\Program Files' })[0]).toContain('chrome.exe');
    });

    test('prefers explicit browser configuration', () => {
        expect(findBrowserExecutable({ env: { CHROME_PATH: '/custom/chrome' } })).toBe('/custom/chrome');
        expect(findBrowserExecutable({
            env: { CHROME_PATH: '/qwen', DEEPSEEK_CHROME_PATH: '/deepseek' },
            preferredEnvKeys: ['DEEPSEEK_CHROME_PATH', 'CHROME_PATH']
        })).toBe('/deepseek');
        expect(findBrowserExecutable({
            env: { CHROME_PATH: '/qwen', DEEPSEEK_CHROME_PATH: '/deepseek' },
            preferredEnvKeys: ['DEEPSEEK_CHROME_PATH', 'CHROME_PATH']
        })).toBe('/deepseek');
        expect(browserCandidates('linux', {}, true)).not.toContain('/usr/bin/chromium-headless-shell');
    });

    test('parses portable startup options', () => {
        expect(parseStartupArgs(['--service', 'deepseek', '--skip-checks'])).toMatchObject({
            service: 'deepseek',
            runChecks: false,
            syncModels: false
        });
        expect(parseStartupArgs(['--service=kimi', '--skip-sync']).service).toBe('kimi');
        expect(() => parseStartupArgs(['--service', 'unknown'])).toThrow();
    });
});
