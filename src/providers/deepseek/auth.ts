import path from 'path';
import type { Page } from 'playwright-core';

import { prompt } from '../../utils/prompt.ts';
import { launchCdpBrowser } from '../../browser/cdp.ts';
import {
    addDeepSeekAccount,
    loadDeepSeekAccounts,
    removeDeepSeekAccount,
    type DeepSeekAccount
} from './accounts.ts';
import { isDeepSeekUrl } from './url.ts';

const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://chat.deepseek.com';
const signInUrl = process.env.DEEPSEEK_SIGN_IN_URL || `${baseUrl}/sign_in`;
const profileDir = path.resolve(process.cwd(), process.env.DEEPSEEK_BROWSER_PROFILE || 'session/deepseek/browser-profile');

async function extractToken(page: Page, capturedToken?: string | null) {
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
    console.log(replaceId ? `Signing in again to DeepSeek: ${replaceId}` : 'Adding a new DeepSeek account');
    console.log('Sign up or sign in at chat.deepseek.com.');
    console.log('When the chat interface appears, come back to this terminal and press Enter.');
    console.log('======================================================');

    const cdp = await launchCdpBrowser({ headless: false, profileDir, startUrl: signInUrl });
    try {
        const context = cdp.browser.contexts()[0];
        if (!context) throw new Error('Browser profile has no default context');
        const page = context.pages().find(candidate => isDeepSeekUrl(candidate.url())) || await context.newPage();
        let capturedToken: string | null = null;
        page.on('request', request => {
            if (!isDeepSeekUrl(request.url())) return;
            const authorization = request.headers()?.authorization || '';
            if (authorization.toLowerCase().startsWith('bearer ')) {
                capturedToken = authorization.slice(7).trim();
            }
        });
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
        if (!isDeepSeekUrl(page.url())) {
            await page.goto(signInUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
        }
        await prompt('Press Enter after signing in and the chat has opened...');
        await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 120_000 }).catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 3000));
        const token = await extractToken(page, capturedToken);
        const cookies = await context.cookies();
        const sessionCookie = cookies.find(cookie => cookie.name === 'ds_session_id');
        if (!sessionCookie) {
            throw new Error('DeepSeek sign-in not confirmed: ds_session_id cookie not found');
        }
        if (!token) {
            throw new Error('DeepSeek sign-in confirmed, but no bearer token was found. Reload the chat page and try again.');
        }
        const id = replaceId || `deepseek_${Date.now()}`;
        addDeepSeekAccount({ id, token, cookies, invalid: false, resetAt: null });
        console.log(`DeepSeek account ${id} saved.`);
        return id;
    } finally {
        await cdp.close();
    }
}

function printAccounts(accounts: DeepSeekAccount[]) {
    console.log('\nDeepSeek accounts:');
    if (!accounts.length) console.log('  (none)');
    accounts.forEach((account, index) => {
        const status = account.invalid ? '❌ Invalid' : '✅ OK';
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
    const account = await pickAccount('Account number to sign in again: ');
    if (account) await addDeepSeekAccountInteractive(account.id);
}

export async function removeDeepSeekAccountInteractive() {
    const account = await pickAccount('Account number to remove: ');
    if (!account) return;
    const confirmation = await prompt(`Remove ${account.id}? (y/N): `);
    if (confirmation.toLowerCase() === 'y') removeDeepSeekAccount(account.id);
}

export async function runDeepSeekAccountMenu() {
    while (true) {
        const accounts = loadDeepSeekAccounts();
        printAccounts(accounts);
        console.log('\n=== DeepSeek menu ===');
        console.log('1 - Sign up or add a new account');
        console.log('2 - Sign in to an account again');
        console.log('3 - Start the proxy (default)');
        console.log('4 - Remove an account');
        let choice = await prompt('Your choice (Enter = 3): ');
        if (!choice) choice = '3';
        if (choice === '1') await addDeepSeekAccountInteractive();
        else if (choice === '2') await reloginDeepSeekAccountInteractive();
        else if (choice === '4') await removeDeepSeekAccountInteractive();
        else if (choice === '3') {
            if (accounts.some(account => !account.invalid)) return;
            console.log('At least one valid DeepSeek account is required.');
        }
    }
}
