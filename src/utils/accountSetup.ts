import fs from 'fs';
import path from 'path';

import { initBrowser, shutdownBrowser, getBrowserContext } from '../browser/browser.ts';
import { extractAuthToken } from '../api/chat.ts';
import { loadTokens, saveTokens, markValid, removeToken } from '../api/tokenManager.ts';
import { loadAuthToken } from '../browser/session.ts';
import { logInfo, logError, logWarn } from '../logger/index.ts';
import { prompt } from './prompt.ts';

import { SESSION_DIR, ACCOUNTS_DIR } from '../config.ts';

const ACCOUNTS_PATH = path.resolve(process.cwd(), SESSION_DIR, ACCOUNTS_DIR);

function ensureAccountDir(id) {
    const accountDir = path.resolve(ACCOUNTS_PATH, id);
    if (!fs.existsSync(accountDir)) fs.mkdirSync(accountDir, { recursive: true });
    return accountDir;
}

export async function addAccountInteractive() {
    logInfo('======================================================');
    logInfo('Добавление нового аккаунта Qwen');
    logInfo('Браузер откроется, войдите в систему, затем вернитесь к консоли.');
    logInfo('======================================================');

    const ok = await initBrowser(true, true);
    if (!ok) {
        logError('Не удалось запустить браузер.');
        return null;
    }

    const ctx = getBrowserContext();
    let token = await extractAuthToken(ctx, true);

    if (!token) {
        token = loadAuthToken();
        if (token) logInfo('Токен получен из сохранённого файла.');
    }

    if (!token) {
        logError('Токен не был получен. Аккаунт не добавлен.');
        await shutdownBrowser();
        return null;
    }

    await shutdownBrowser();

    const id = 'acc_' + Date.now();
    ensureAccountDir(id);
    fs.writeFileSync(path.resolve(ACCOUNTS_PATH, id, 'token.txt'), token, 'utf8');

    const list = loadTokens();
    list.push({ id, token, resetAt: null });
    saveTokens(list);

    logInfo(`Аккаунт '${id}' добавлен. Всего аккаунтов: ${list.length}`);
    logInfo('======================================================');
    return id;
}

export async function reloginAccountInteractive() {
    const tokens = loadTokens();
    const invalids = tokens.filter(t => t.invalid);
    if (!invalids.length) {
        console.log('Нет аккаунтов, требующих повторного входа.');
        await prompt('Нажмите ENTER чтобы вернуться в меню...');
        return;
    }

    console.log('\nАккаунты с истекшим токеном:');
    invalids.forEach((t, idx) => console.log(`${idx + 1} - ${t.id}`));
    const choice = await prompt('Выберите номер аккаунта для повторного входа: ');
    const num = parseInt(choice, 10);
    if (isNaN(num) || num < 1 || num > invalids.length) {
        console.log('Неверный выбор.');
        return;
    }
    const account = invalids[num - 1];

    logInfo(`Повторная авторизация для ${account.id}`);
    const ok = await initBrowser(true, true);
    if (!ok) { logError('Не удалось запустить браузер.'); return; }

    const token = await extractAuthToken(getBrowserContext(), true);
    await shutdownBrowser();

    if (!token) { logError('Не удалось извлечь токен.'); return; }

    markValid(account.id, token);
    fs.writeFileSync(path.resolve(ACCOUNTS_PATH, account.id, 'token.txt'), token, 'utf8');
    logInfo(`Токен обновлён для ${account.id}`);
}

export async function removeAccountInteractive() {
    const tokens = loadTokens();
    if (!tokens.length) {
        console.log('Нет сохранённых аккаунтов.');
        await prompt('ENTER чтобы вернуться...');
        return;
    }

    console.log('\nДоступные аккаунты:');
    tokens.forEach((t, idx) => console.log(`${idx + 1} - ${t.id}`));
    const choice = await prompt('Номер аккаунта, который нужно удалить (или ENTER для отмены): ');
    if (!choice) return;
    const num = parseInt(choice, 10);
    if (isNaN(num) || num < 1 || num > tokens.length) {
        console.log('Неверный выбор.');
        await prompt('ENTER чтобы вернуться...');
        return;
    }

    const acc = tokens[num - 1];
    const confirm = await prompt(`Точно удалить ${acc.id}? (y/N): `);
    if (confirm.toLowerCase() !== 'y') return;

    removeToken(acc.id);
    const dir = path.resolve(ACCOUNTS_PATH, acc.id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });

    logInfo(`Аккаунт ${acc.id} удалён.`);
    await prompt('ENTER чтобы вернуться...');
}
