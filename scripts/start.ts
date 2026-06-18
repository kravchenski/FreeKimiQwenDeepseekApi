import { hasValidTokens } from '../src/api/tokenManager.ts';
import { hasValidDeepSeekAccounts } from '../src/providers/deepseek/accounts.ts';
import { hasValidKimiAccounts } from '../src/providers/kimi/accounts.ts';
import { parseStartupArgs, type Service } from '../src/cli/startup.ts';

const usage = `Usage: bun run start:full -- [options]

Cross-platform install, validation, authentication, and startup.

Options:
  --service <qwen|deepseek|kimi|gateway>  Service to start (default: qwen)
  --auth                            Always open the selected provider login flow
  --skip-auth                       Skip account validation and login
  --skip-checks                     Skip offline analysis, tests, and build validation
  --skip-sync                       Skip Qwen model synchronization
  --check-only                      Install dependencies, run checks, and exit
  -h, --help                        Show this help
`;

function log(message: string) {
    console.log(`\n==> ${message}`);
}

async function run(args: string[], env: Record<string, string> = {}) {
    const child = Bun.spawn([process.execPath, ...args], {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit'
    });
    return child.exited;
}

async function requireSuccess(args: string[], env: Record<string, string> = {}) {
    const code = await run(args, env);
    if (code !== 0) throw new Error(`Command failed (${code}): bun ${args.join(' ')}`);
}

function hasAccount(service: Service) {
    if (service === 'qwen') return hasValidTokens();
    if (service === 'deepseek') return hasValidDeepSeekAccounts() || Boolean(process.env.DEEPSEEK_TOKEN);
    if (service === 'kimi') return hasValidKimiAccounts() || Boolean(process.env.KIMI_TOKEN) || Boolean(process.env.ZENMUX_API_KEY);
    return true;
}

async function authenticate(service: Service) {
    if (service === 'qwen') return requireSuccess(['run', 'auth', '--', '--add']);
    if (service === 'deepseek') return requireSuccess(['run', 'auth:deepseek', '--', '--add']);
    if (service === 'kimi') return; // ZenMux — не требует браузерной аутентификации
}

async function start(service: Service) {
    const script = service === 'qwen' ? 'start' :
        service === 'deepseek' ? 'start:deepseek' :
            service === 'kimi' ? 'start:kimi' : 'start:gateway';
    const code = await run(['run', script], service === 'gateway' ? {} : { SKIP_ACCOUNT_MENU: 'true' });
    process.exitCode = code;
}

export async function main(args = process.argv.slice(2)) {
    const options = parseStartupArgs(args);
    if (options.help) {
        console.log(usage);
        return;
    }

    log('Installing dependencies from bun.lock');
    await requireSuccess(['install', '--frozen-lockfile'], {
        PUPPETEER_SKIP_DOWNLOAD: 'true',
        PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: 'true'
    });

    if (options.runChecks) {
        log('Running static analysis, tests, and build validation');
        await requireSuccess(['run', 'ci']);
    }
    if (options.checkOnly) return;

    if (options.runAuth && (options.forceAuth || !hasAccount(options.service))) {
        if (!process.stdin.isTTY) throw new Error(`No active ${options.service} account and no interactive terminal available.`);
        log(`Opening ${options.service} authentication`);
        await authenticate(options.service);
        if (!hasAccount(options.service)) throw new Error(`Authentication finished without an active ${options.service} account.`);
    }

    if (options.syncModels) {
        log('Synchronizing Qwen model metadata');
        const code = await run(['run', 'models:sync']);
        if (code !== 0) console.warn('Model synchronization failed; using src/AvailableModels.txt');
    }

    log(`Starting ${options.service}`);
    await start(options.service);
}

if (import.meta.main) {
    main().catch(error => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
