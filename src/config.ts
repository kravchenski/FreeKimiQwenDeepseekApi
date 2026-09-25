import { z } from 'zod';

const blankToUndefined = (value: unknown) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value;

const positiveInt = (fallback: number) =>
    z.preprocess(blankToUndefined, z.coerce.number().int().positive().default(fallback));

const nonNegativeInt = (fallback: number) =>
    z.preprocess(blankToUndefined, z.coerce.number().int().nonnegative().default(fallback));

const port = (fallback: number) =>
    z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(65_535).default(fallback));

const url = (fallback?: string) =>
    fallback === undefined
        ? z.preprocess(blankToUndefined, z.url().optional())
        : z.preprocess(blankToUndefined, z.url().default(fallback));

const text = (fallback: string) => z.preprocess(blankToUndefined, z.string().default(fallback));

const flag = z.preprocess(
    value => typeof value === 'string' ? ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()) : Boolean(value),
    z.boolean()
);

const envSchema = z.object({
    QWEN_BASE_URL: url('https://chat.qwen.ai'),
    CHAT_API_URL: url(),
    CREATE_CHAT_URL: url(),
    CHAT_PAGE_URL: url(),
    TASK_STATUS_URL: url(),
    STS_TOKEN_API_URL: url(),
    AUTH_SIGNIN_URL: url(),
    OSS_SDK_URL: url('https://gosspublic.alicdn.com/aliyun-oss-sdk-6.20.0.min.js'),

    PAGE_TIMEOUT: positiveInt(120_000),
    NAVIGATION_TIMEOUT: positiveInt(60_000),
    RETRY_DELAY: positiveInt(2_000),
    STREAMING_CHUNK_DELAY: positiveInt(20),

    PAGE_POOL_SIZE: positiveInt(3),
    MAX_FILE_SIZE: positiveInt(10 * 1024 * 1024),
    MAX_RETRY_COUNT: positiveInt(3),
    TASK_POLL_MAX_ATTEMPTS: positiveInt(90),
    TASK_POLL_INTERVAL: positiveInt(2_000),
    REQUEST_BODY_LIMIT: z.preprocess(blankToUndefined, z.string().regex(/^\d+(?:kb|mb|gb)?$/i).default('25mb')),
    RATE_LIMIT_WINDOW_MS: positiveInt(60_000),
    RATE_LIMIT_MAX_REQUESTS: nonNegativeInt(120),

    SESSION_DIR: text('session'),
    UPLOADS_DIR: text('uploads'),
    LOGS_DIR: text('logs'),

    VIEWPORT_WIDTH: positiveInt(1920),
    VIEWPORT_HEIGHT: positiveInt(1080),
    USER_AGENT: text('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'),

    PORT: port(3264),
    HOST: text('0.0.0.0'),
    DEFAULT_MODEL: text('qwen-max-latest'),
    ALLOW_UNSCOPED_SESSION_CHAT_RESTORE: flag,
    CORS_ALLOWED_ORIGINS: z.preprocess(
        value => String(value ?? '').split(',').map(item => item.trim()).filter(Boolean),
        z.array(z.string())
    ),

    LOG_LEVEL: z.preprocess(blankToUndefined, z.enum(['error', 'warn', 'info', 'http', 'debug', 'raw']).default('info')),
    LOG_MAX_SIZE: positiveInt(5_242_880),
    LOG_MAX_FILES: positiveInt(5),
});

export function parseEnv(env: Record<string, string | undefined>) {
    const result = envSchema.safeParse(env);
    if (!result.success) {
        const issues = result.error.issues.map(issue => `  ${issue.path.join('.')}: ${issue.message}`).join('\n');
        throw new Error(`Invalid environment configuration:\n${issues}`);
    }
    return result.data;
}

const env = parseEnv(process.env);

export const CHAT_API_URL = env.CHAT_API_URL || `${env.QWEN_BASE_URL}/api/v2/chat/completions`;
export const CREATE_CHAT_URL = env.CREATE_CHAT_URL || `${env.QWEN_BASE_URL}/api/v2/chats/new`;
export const CHAT_PAGE_URL = env.CHAT_PAGE_URL || `${env.QWEN_BASE_URL}/`;
export const TASK_STATUS_URL = env.TASK_STATUS_URL || `${env.QWEN_BASE_URL}/api/v1/tasks/status`;
export const STS_TOKEN_API_URL = env.STS_TOKEN_API_URL || `${env.QWEN_BASE_URL}/api/v1/files/getstsToken`;
export const AUTH_SIGNIN_URL = env.AUTH_SIGNIN_URL || `${env.QWEN_BASE_URL}/auth?action=signin`;
export const OSS_SDK_URL = env.OSS_SDK_URL;

export const PAGE_TIMEOUT = env.PAGE_TIMEOUT;
export const NAVIGATION_TIMEOUT = env.NAVIGATION_TIMEOUT;
export const RETRY_DELAY = env.RETRY_DELAY;
export const STREAMING_CHUNK_DELAY = env.STREAMING_CHUNK_DELAY;

export const PAGE_POOL_SIZE = env.PAGE_POOL_SIZE;
export const MAX_FILE_SIZE = env.MAX_FILE_SIZE;
export const MAX_RETRY_COUNT = env.MAX_RETRY_COUNT;
export const TASK_POLL_MAX_ATTEMPTS = env.TASK_POLL_MAX_ATTEMPTS;
export const TASK_POLL_INTERVAL = env.TASK_POLL_INTERVAL;
export const REQUEST_BODY_LIMIT = env.REQUEST_BODY_LIMIT;
export const RATE_LIMIT_WINDOW_MS = env.RATE_LIMIT_WINDOW_MS;
export const RATE_LIMIT_MAX_REQUESTS = env.RATE_LIMIT_MAX_REQUESTS;

export const SESSION_DIR = env.SESSION_DIR;
export const ACCOUNTS_DIR = 'accounts';
export const UPLOADS_DIR = env.UPLOADS_DIR;
export const LOGS_DIR = env.LOGS_DIR;

export const VIEWPORT_WIDTH = env.VIEWPORT_WIDTH;
export const VIEWPORT_HEIGHT = env.VIEWPORT_HEIGHT;
export const USER_AGENT = env.USER_AGENT;

export const PORT = env.PORT;
export const HOST = env.HOST;
export const DEFAULT_MODEL = env.DEFAULT_MODEL;
export const ALLOW_UNSCOPED_SESSION_CHAT_RESTORE = env.ALLOW_UNSCOPED_SESSION_CHAT_RESTORE;
export const CORS_ALLOWED_ORIGINS = env.CORS_ALLOWED_ORIGINS;

export const LOG_LEVEL = env.LOG_LEVEL;
export const LOG_MAX_SIZE = env.LOG_MAX_SIZE;
export const LOG_MAX_FILES = env.LOG_MAX_FILES;
