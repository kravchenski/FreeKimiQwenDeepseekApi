import fs from 'node:fs';
import path from 'node:path';

type Platform = NodeJS.Platform;
type Environment = Record<string, string | undefined>;

export function browserCandidates(
    platform: Platform = process.platform,
    env: Environment = process.env,
    interactive = false
) {
    if (platform === 'win32') {
        const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']].filter(Boolean) as string[];
        return roots.flatMap(root => [
            path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.win32.join(root, 'Chromium', 'Application', 'chrome.exe'),
            path.win32.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.win32.join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
        ]);
    }

    if (platform === 'darwin') {
        const system = [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
        ];
        const home = env.HOME;
        return home ? [
            ...system,
            ...system.map(candidate => path.posix.join(home, candidate))
        ] : system;
    }

    const candidates = [
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium-headless-shell',
        '/snap/bin/chromium'
    ];
    return interactive ? candidates.filter(candidate => !candidate.includes('headless')) : candidates;
}

export function findBrowserExecutable(options: {
    platform?: Platform;
    env?: Environment;
    exists?: (file: string) => boolean;
    interactive?: boolean;
    preferredEnvKeys?: string[];
} = {}) {
    const env = options.env || process.env;
    const explicit = (options.preferredEnvKeys || ['CHROME_PATH'])
        .map(key => env[key])
        .find(Boolean);
    if (explicit) return explicit;
    const exists = options.exists || fs.existsSync;
    return browserCandidates(options.platform || process.platform, env, options.interactive).find(exists) || null;
}

export function requireBrowserExecutable(options: Parameters<typeof findBrowserExecutable>[0] = {}) {
    const executable = findBrowserExecutable(options);
    if (executable) return executable;
    throw new Error(
        'Chrome/Chromium/Edge/Brave не найден. Установите браузер или задайте CHROME_PATH/DEEPSEEK_CHROME_PATH.'
    );
}
