#!/usr/bin/env node

import { hasValidDeepSeekAccounts, loadDeepSeekAccounts } from '../src/providers/deepseek/accounts.ts';
import { hasValidChatgptAccounts, loadChatgptAccounts } from '../src/providers/chatgpt/accounts.ts';
import { hasValidQwenAccounts, loadQwenAccounts } from '../src/providers/qwen/accounts.ts';
import { hasValidGeminiAccounts, loadGeminiAccounts } from '../src/providers/gemini/accounts.ts';

import { addDeepSeekAccountInteractive } from '../src/providers/deepseek/auth.ts';
import { addChatgptAccountInteractive } from '../src/providers/chatgpt/auth.ts';
import { addQwenAccountInteractive } from '../src/providers/qwen/auth.ts';
import { addGeminiAccountInteractive } from '../src/providers/gemini/auth.ts';

const providers: ProviderSetup[] = [
    {
        name: 'DeepSeek',
        hasValid: hasValidDeepSeekAccounts,
        count: () => loadDeepSeekAccounts().filter(a => !a.invalid).length,
        addInteractive: addDeepSeekAccountInteractive,
    },
    {
        name: 'ChatGPT',
        hasValid: hasValidChatgptAccounts,
        count: () => loadChatgptAccounts().filter(a => !a.invalid).length,
        addInteractive: addChatgptAccountInteractive,
    },
    {
        name: 'Qwen',
        hasValid: hasValidQwenAccounts,
        count: () => loadQwenAccounts().filter(a => !a.invalid).length,
        addInteractive: addQwenAccountInteractive,
    },
    {
        name: 'Gemini',
        hasValid: hasValidGeminiAccounts,
        count: () => loadGeminiAccounts().filter(a => !a.invalid).length,
        addInteractive: addGeminiAccountInteractive,
    },
];

async function run(args: string[]) {
    const child = Bun.spawn([process.execPath, ...args], {
        cwd: process.cwd(),
        env: { ...process.env },
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit'
    });
    const code = await child.exited;
    if (code !== 0) throw new Error(`Command failed: bun ${args.join(' ')}`);
}

async function main() {
    console.log(`\n  FreeQwenApi — Full Setup & Start\n`);

    for (const p of providers) {
        const existing = p.count();
        if (existing > 0 && p.hasValid()) {
            console.log(`  ✓ ${p.name}: ${existing} аккаунт(ов)`);
            continue;
        }
        console.log(`  → ${p.name}: нет аккаунтов. Откроется браузер для входа.\n`);
        try {
            await p.addInteractive();
        } catch (err) {
            console.error(`  ✗ ${p.name}: ${err instanceof Error ? err.message : err}`);
        }
    }

    const ds = loadDeepSeekAccounts().filter((a: any) => !a.invalid).length;
    const cg = loadChatgptAccounts().filter((a: any) => !a.invalid).length;
    const qw = loadQwenAccounts().filter((a: any) => !a.invalid).length;
    const ge = loadGeminiAccounts().filter((a: any) => !a.invalid).length;

    console.log(`\n  ✓ Аккаунты:`);
    console.log(`    DeepSeek:  ${ds}`);
    console.log(`    ChatGPT:   ${cg}`);
    console.log(`    Qwen:      ${qw}`);
    console.log(`    Gemini:    ${ge}`);
    console.log(`\n  Запуск сервера...\n`);

    await run(['run', 'start']);
}

main().catch(e => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});
