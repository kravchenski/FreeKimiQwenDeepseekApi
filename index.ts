import { Hono } from 'hono';
import { serve } from 'bun';
import { cors } from 'hono/cors';

import { initBrowser, shutdownBrowser } from './src/browser/browser.ts';
import apiRoutes from './src/api/routes.ts';
import { getAvailableModelsFromFile, getApiKeys } from './src/api/chat.ts';
import { loadTokens } from './src/api/tokenManager.ts';
import { addAccountInteractive } from './src/utils/accountSetup.ts';
import { logHttpRequest, logInfo, logError, logWarn } from './src/logger/index.ts';
import { prompt } from './src/utils/prompt.ts';
import { PORT, HOST, REQUEST_BODY_LIMIT } from './src/config.ts';

const app = new Hono();

const port = Number.parseInt(process.env.PORT ?? PORT, 10);
const host = process.env.HOST || HOST;

if (Number.isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`Некорректное значение переменной PORT: ${process.env.PORT}`);
}

function toBoolean(value) {
    if (typeof value !== 'string') return false;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

const skipAccountMenu = toBoolean(process.env.SKIP_ACCOUNT_MENU) || toBoolean(process.env.NON_INTERACTIVE);

function ensureNonInteractiveTokens() {
    const tokens = loadTokens();
    if (!tokens.length) {
        logError('Не найдено ни одного аккаунта. Запустите скрипт авторизации перед запуском сервера.');
        process.exit(1);
    }
    const now = Date.now();
    const validTokens = tokens.filter(t => (!t.resetAt || new Date(t.resetAt).getTime() <= now) && !t.invalid);
    if (!validTokens.length) {
        logError('Все аккаунты недоступны. Перезапустите авторизацию перед запуском сервера.');
        process.exit(1);
    }
    logInfo(`Автоматический запуск: обнаружено ${tokens.length} аккаунтов, из них ${validTokens.length} активны.`);
}

app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    logHttpRequest(c.req.raw, { status: c.res.status, get: () => '' } as any, () => {});
});

app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
}));

app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-XSS-Protection', '1; mode=block');
    await next();
});

app.use('/api/*', async (c, next) => {
    const contentLength = Number(c.req.header('content-length') || 0);
    const limit = parseInt(REQUEST_BODY_LIMIT) || 25 * 1024 * 1024;
    if (contentLength > limit) return c.json({ error: 'Тело запроса превышает допустимый размер' }, 413);
    await next();
});

app.use('/api/*', async (c, next) => {
    const contentType = c.req.header('content-type') || '';
    if (contentType.includes('application/json') && c.req.method === 'POST') {
        try {
            await c.req.json();
        } catch {
            return c.json({ error: 'Некорректный JSON', message: 'Проверьте тело запроса: используйте валидный JSON с двойными кавычками.' }, 400);
        }
    }
    await next();
});

app.use('/api/*', async (c, next) => {
    const url = new URL(c.req.url);
    if (url.pathname.startsWith('/api/v') && /\/v\d+\//.test(url.pathname)) {
        const newPath = url.pathname.replace(/\/v\d+/, '');
        const newUrl = `${url.pathname.replace(/\/v\d+/, '')}${url.search}`;
        return c.redirect(newUrl, 301);
    }
    await next();
});

app.use('/api/*', async (c, next) => {
    const apiKeyHeader = c.req.header('x-api-key');
    const authHeader = c.req.header('authorization');
    const validKeys = getApiKeys();
    if (validKeys.length > 0) {
        const providedKey = apiKeyHeader || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null);
        if (!providedKey || !validKeys.includes(providedKey)) {
            return c.json({ error: 'Unauthorized', message: 'Invalid or missing API key' }, 401);
        }
    }
    await next();
});

app.route('/api', apiRoutes);

app.notFound((c) => {
    logWarn(`404 Not Found: ${c.req.method} ${c.req.url}`);
    return c.json({ error: 'Эндпоинт не найден' }, 404);
});

app.onError((err, c) => {
    logError('Внутренняя ошибка сервера', err);
    return c.json({ error: 'Внутренняя ошибка сервера' }, 500);
});

let server: ReturnType<typeof serve> | null = null;

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
process.on('SIGHUP', handleShutdown);
process.on('uncaughtException', async (error) => {
    logError('Необработанное исключение', error);
    await handleShutdown();
});

async function handleShutdown() {
    logInfo('\nПолучен сигнал завершения. Закрываем браузер...');
    if (server) {
        server.stop(true);
        server = null;
    }
    await shutdownBrowser();
    logInfo('Завершение работы.');
    process.exit(0);
}

async function startServer() {
    console.log(`
███████ ██████  ███████ ███████  ██████  ██     ██ ███████ ███    ██  █████  ██████  ██
██      ██   ██ ██      ██      ██    ██ ██     ██ ██      ████   ██ ██   ██ ██   ██ ██
███████ ██████  █████   █████   ██    ██ ██  █  ██ █████   ██ ██  ██ ███████ ██████  ██
██      ██   ██ ██      ██      ██ ▄▄ ██ ██ ███ ██ ██      ██  ██ ██ ██   ██ ██      ██
██      ██   ██ ███████ ███████  ██████   ███ ███  ███████ ██   ████ ██   ██ ██      ██
                                    ▀▀
   FreeQwenApi — API-прокси для Qwen
`);

    logInfo('Запуск сервера...');

    if (!skipAccountMenu) {
        while (true) {
            const tokens = loadTokens();
            console.log('\nСписок аккаунтов:');
            if (!tokens.length) {
                console.log('  (пусто)');
            } else {
                tokens.forEach((token, i) => {
                    const now = Date.now();
                    const isInvalid = token.invalid === true;
                    const isWaiting = Boolean(token.resetAt && new Date(token.resetAt).getTime() > now);
                    const statusLabel = isInvalid ? '❌ Недействителен' : isWaiting ? '⏳ Ожидание сброса' : '✅ OK';
                    const statusCode = isInvalid ? 0 : isWaiting ? 1 : 2;
                    console.log(`${String(i + 1).padStart(2, ' ')} | ${token.id} | ${statusLabel} (${statusCode})`);
                });
            }
            console.log('\n=== Меню ===');
            console.log(`FreeQwenApi`);
            console.log('1 - Добавить новый аккаунт');
            console.log('2 - Перелогинить аккаунт с истекшим токеном');
            console.log('3 - Запустить прокси (по умолчанию)');
            console.log('4 - Удалить аккаунт');

            let choice = await prompt('Ваш выбор (Enter = 3): ');
            if (!choice) choice = '3';

            if (choice === '1') {
                await addAccountInteractive();
            } else if (choice === '2') {
                const { reloginAccountInteractive } = await import('./src/utils/accountSetup.ts');
                await reloginAccountInteractive();
            } else if (choice === '3') {
                const hasValidToken = tokens.some(t => {
                    if (t.invalid) return false;
                    if (!t.resetAt) return true;
                    return new Date(t.resetAt).getTime() <= Date.now();
                });
                if (!tokens.length || !hasValidToken) {
                    console.log('Нужен хотя бы один валидный аккаунт для запуска.');
                    continue;
                }
                break;
            } else if (choice === '4') {
                const { removeAccountInteractive } = await import('./src/utils/accountSetup.ts');
                await removeAccountInteractive();
            }
        }
    } else {
        ensureNonInteractiveTokens();
    }

    const browserInitialized = await initBrowser(false);
    if (!browserInitialized) {
        logError('Не удалось инициализировать браузер. Завершение работы.');
        process.exit(1);
    }

    try {
        server = serve({ fetch: app.fetch, port, hostname: host, idleTimeout: 255 });
        const displayHost = host === '0.0.0.0' ? 'localhost' : host;
        logInfo(`Сервер запущен на ${host}:${port}`);
        logInfo(`API доступен по адресу: http://${displayHost}:${port}/api`);
        logInfo('Для проверки статуса авторизации: GET /api/status');
        logInfo('Для отправки сообщения: POST /api/chat');
        logInfo('Для получения списка моделей: GET /api/models');
        logInfo('======================================================');
        logInfo('API v2 - История чатов хранится на серверах Qwen');
        logInfo('Создать новый чат: POST /api/chats');
        logInfo('Отправить сообщение: POST /api/chat (с chatId и parentId)');
        logInfo('======================================================');
        logInfo('Доступно 25 моделей Qwen (через систему маппинга):');
        logInfo('- Стандартные: qwen-max, qwen-plus, qwen-turbo и их latest-версии');
        logInfo('- Coder: qwen3-coder-plus, qwen2.5-coder-*b-instruct (0.5b - 32b)');
        logInfo('- Визуальные: qwen-vl-max, qwen-vl-plus и их latest-версии');
        logInfo('- Qwen 3: qwen3, qwen3-max, qwen3-plus, qwen3-omni-flash');
        logInfo('- Qwen 3.5: qwen3.5-plus, qwen3.5-flash, qwen3.5-397b-a17b, qwen3.5-122b-a10b, qwen3.5-27b, qwen3.5-35b-a3b');
        logInfo('======================================================');
        logInfo('Формат JSON запроса на чат:');
        logInfo('{ "message": "текст сообщения", "model": "название модели (опционально)", "chatId": "ID чата (опционально)", "parentId": "ID родительского сообщения (опционально)" }');
        logInfo('Пример первого запроса: { "message": "Привет, как дела?" }');
        logInfo('Пример второго запроса: { "message": "А что ты умеешь?", "chatId": "полученный_id_чата", "parentId": "полученный_parentId" }');
        logInfo('======================================================');
        logInfo('Поддержка OpenAI совместимого API: POST /api/chat/completions');
        logInfo('В ответе возвращаются chatId и parentId для продолжения диалога');
        logInfo('======================================================');

        getApiKeys();
        getAvailableModelsFromFile();
    } catch (err) {
        if (err.code === 'EADDRINUSE') {
            logError(`Порт ${port} уже используется. Возможно, сервер уже запущен.`);
            await shutdownBrowser();
            process.exit(1);
        }
        throw err;
    }
}

startServer().catch(async error => {
    logError('Ошибка при запуске сервера', error);
    await shutdownBrowser();
    process.exit(1);
});
