export type Service = 'qwen' | 'deepseek' | 'gateway';

export type StartupOptions = {
    service: Service;
    runChecks: boolean;
    runAuth: boolean;
    forceAuth: boolean;
    syncModels: boolean;
    checkOnly: boolean;
    help: boolean;
};

export function parseStartupArgs(args: string[]): StartupOptions {
    const options: StartupOptions = {
        service: 'qwen',
        runChecks: true,
        runAuth: true,
        forceAuth: false,
        syncModels: true,
        checkOnly: false,
        help: false
    };

    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--auth') options.forceAuth = true;
        else if (arg === '--skip-auth') options.runAuth = false;
        else if (arg === '--skip-checks') options.runChecks = false;
        else if (arg === '--skip-sync') options.syncModels = false;
        else if (arg === '--check-only') {
            options.checkOnly = true;
            options.runAuth = false;
            options.syncModels = false;
        } else if (arg === '--service') {
            const value = args[++index];
            if (!isService(value)) throw new Error(`Unknown service: ${value || '(missing)'}`);
            options.service = value;
        } else if (arg.startsWith('--service=')) {
            const value = arg.slice('--service='.length);
            if (!isService(value)) throw new Error(`Unknown service: ${value}`);
            options.service = value;
        } else if (arg === '--help' || arg === '-h') options.help = true;
        else throw new Error(`Unknown option: ${arg}`);
    }

    if (options.service !== 'qwen') options.syncModels = false;
    if (options.service === 'gateway') options.runAuth = false;
    return options;
}

function isService(value: unknown): value is Service {
    return value === 'qwen' || value === 'deepseek' || value === 'gateway';
}
