import { z } from 'zod';

const blankToUndefined = (value: unknown) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value;

const port = (fallback: number) =>
    z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(65_535).default(fallback));

const text = (fallback: string) => z.preprocess(blankToUndefined, z.string().default(fallback));

const optionalText = z.preprocess(blankToUndefined, z.string().optional());

const envSchema = z.object({
    UNIFIED_PORT: port(3260),
    HOST: text('0.0.0.0'),
    SESSION_DIR: text('session'),
    GATEWAY_API_KEY: optionalText,
    AUTO_MODELS: optionalText,
});

export type Config = z.infer<typeof envSchema>;

export function parseEnv(env: Record<string, string | undefined>): Config {
    const result = envSchema.safeParse(env);
    if (!result.success) {
        const issues = result.error.issues.map(issue => `  ${issue.path.join('.')}: ${issue.message}`).join('\n');
        throw new Error(`Invalid environment configuration:\n${issues}`);
    }
    return result.data;
}

export function loadConfig(env: Record<string, string | undefined> = process.env) {
    return parseEnv(env);
}
