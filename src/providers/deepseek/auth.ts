import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { prompt } from '../../utils/prompt.ts';
import { requireBrowserExecutable } from '../../platform/browserExecutable.ts';
import {
    addDeepSeekAccount,
    loadDeepSeekAccounts,
    removeDeepSeekAccount,
    type DeepSeekAccount
} from './accounts.ts';

puppeteer.use(StealthPlugin());

const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://chat.deepseek.com';
const signInUrl = process.env.DEEPSEEK_SIGN_IN_URL || `${baseUrl}/sign_in`;
const debugPort = Number(process.env.DEEPSEEK_AUTH_DEBUG_PORT || 9223);
const profileDir = path.resolve(process.cwd(), process.env.DEEPSEEK_BROWSER_PROFILE || 'session/deepseek/browser-profile');

async function waitForDebugBrowser() {
    for (let attempt = 0; attempt < 60; attempt++) {
        try {
            const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
            if (response.ok) return await response.json() as { webSocketDebuggerUrl: string };
        } catch {
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Системный Chromium не открыл remote debugging порт');
}

async function launchUserBrowser() {
    fs.mkdirSync(profileDir, { recursive: true });
    const executable = requireBrowserExecutable({
        interactive: true,
        preferredEnvKeys: ['DEEPSEEK_CHROME_PATH', 'CHROME_PATH']
    });
    const processHandle = spawn(executable, [
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--start-maximized',
        signInUrl
    ], { detached: false, stdio: 'ignore' });
    const debug = await waitForDebugBrowser();
    const browser = await puppeteer.connect({
        browserWSEndpoint: debug.webSocketDebuggerUrl,
        defaultViewport: null
    });
    return { browser, processHandle };
}

async function extractToken(page: any, capturedToken?: string | null) {
    if (capturedToken) return capturedToken;
    const storageToken = await page.evaluate(() => {
        const stores = [localStorage, sessionStorage];
        const preferred = ['token', 'auth_token', 'access_token', 'userToken'];
        for (const store of stores) {
            for (const key of preferred) {
                const value = store.getItem(key);
                if (value) return value;
            }
            for (let index = 0; index < store.length; index++) {
                const key = store.key(index);
                if (!key || !/token|auth/i.test(key)) continue;
                const value = store.getItem(key);
                if (value) return value;
            }
        }
        return null;
    });
    if (storageToken) return storageToken;

    return page.evaluate(async () => {
        const response = await fetch('/api/v0/users/current', { credentials: 'include' });
        const body = await response.json().catch(() => null);
        return body?.data?.biz_data?.token || body?.data?.token ||
            body?.data?.biz_data?.user?.token || null;
    });
}

export async function addDeepSeekAccountInteractive(replaceId?: string) {
    console.log('\n======================================================');
    console.log(replaceId ? `Повторный вход DeepSeek: ${replaceId}` : 'Добавление нового аккаунта DeepSeek');
    console.log('Зарегистрируйтесь или войдите на chat.deepseek.com.');
    console.log('После появления интерфейса чата вернитесь в консоль и нажмите Enter.');
    console.log('======================================================');

    const { browser, processHandle } = await launchUserBrowser();
    try {
        const pages = await browser.pages();
        const page = pages.find((candidate: any) => candidate.url().includes('deepseek.com')) || await browser.newPage();
        let capturedToken: string | null = null;
        page.on('request', (request: any) => {
            const authorization = request.headers()?.authorization || '';
            if (authorization.toLowerCase().startsWith('bearer ')) {
                capturedToken = authorization.slice(7).trim();
            }
        });
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
        if (!page.url().includes('deepseek.com')) {
            await page.goto(signInUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
        }
        await prompt('После регистрации/входа и появления чата нажмите Enter...');
        await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 120_000 }).catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 3000));
        const token = await extractToken(page, capturedToken);
        const cookies = await page.cookies();
        const sessionCookie = cookies.find((cookie: any) => cookie.name === 'ds_session_id');
        if (!sessionCookie) {
            throw new Error('DeepSeek login не подтверждён: cookie ds_session_id не найден');
        }
        if (!token) {
            throw new Error('DeepSeek login подтверждён, но Bearer token не найден. Обновите страницу чата и повторите.');
        }
        const id = replaceId || `deepseek_${Date.now()}`;
        addDeepSeekAccount({ id, token, cookies, invalid: false, resetAt: null });
        console.log(`Аккаунт DeepSeek ${id} сохранён.`);
        return id;
    } finally {
        await browser.disconnect();
        processHandle.kill('SIGTERM');
    }
}

function printAccounts(accounts: DeepSeekAccount[]) {
    console.log('\nСписок аккаунтов DeepSeek:');
    if (!accounts.length) console.log('  (пусто)');
    accounts.forEach((account, index) => {
        const status = account.invalid ? '❌ Недействителен' : '✅ OK';
        console.log(`${String(index + 1).padStart(2, ' ')} | ${account.id} | ${status}`);
    });
}

async function pickAccount(question: string) {
    const accounts = loadDeepSeekAccounts();
    printAccounts(accounts);
    if (!accounts.length) return null;
    const choice = Number(await prompt(question));
    return Number.isInteger(choice) && choice >= 1 && choice <= accounts.length ? accounts[choice - 1] : null;
}

export async function reloginDeepSeekAccountInteractive() {
    const account = await pickAccount('Номер аккаунта для повторного входа: ');
    if (account) await addDeepSeekAccountInteractive(account.id);
}

export async function removeDeepSeekAccountInteractive() {
    const account = await pickAccount('Номер аккаунта для удаления: ');
    if (!account) return;
    const confirmation = await prompt(`Удалить ${account.id}? (y/N): `);
    if (confirmation.toLowerCase() === 'y') removeDeepSeekAccount(account.id);
}

export async function runDeepSeekAccountMenu() {
    while (true) {
        const accounts = loadDeepSeekAccounts();
        printAccounts(accounts);
        console.log('\n=== Меню DeepSeek ===');
        console.log('1 - Зарегистрировать или добавить новый аккаунт');
        console.log('2 - Перелогинить аккаунт');
        console.log('3 - Запустить прокси (по умолчанию)');
        console.log('4 - Удалить аккаунт');
        let choice = await prompt('Ваш выбор (Enter = 3): ');
        if (!choice) choice = '3';
        if (choice === '1') await addDeepSeekAccountInteractive();
        else if (choice === '2') await reloginDeepSeekAccountInteractive();
        else if (choice === '4') await removeDeepSeekAccountInteractive();
        else if (choice === '3') {
            if (accounts.some(account => !account.invalid)) return;
            console.log('Нужен хотя бы один валидный аккаунт DeepSeek.');
        }
    }
}
