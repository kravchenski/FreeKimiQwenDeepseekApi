import fs from 'fs';
import path from 'path';

const root = path.resolve(process.cwd(), process.env.QWEN_SESSION_DIR || 'session/qwen');
const accountsDir = path.join(root, 'accounts');
const accountsFile = path.join(root, 'accounts.json');
let pointer = 0;

export type QwenAccount = {
    id: string;
    token: string;
    invalid?: boolean;
    resetAt?: string | null;
};

function ensureStorage() {
    fs.mkdirSync(accountsDir, { recursive: true });
}

export function loadQwenAccounts(): QwenAccount[] {
    ensureStorage();
    if (!fs.existsSync(accountsFile)) return [];
    try {
        const accounts = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
        return Array.isArray(accounts) ? accounts.filter(isQwenAccount) : [];
    } catch {
        return [];
    }
}

function isQwenAccount(value: unknown): value is QwenAccount {
    const account = value as Partial<QwenAccount>;
    return Boolean(account && typeof account.id === 'string' && typeof account.token === 'string');
}

function saveQwenAccounts(accounts: QwenAccount[]) {
    ensureStorage();
    const temporary = `${accountsFile}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(accounts, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, accountsFile);
    fs.chmodSync(accountsFile, 0o600);
}

export function addQwenAccount(account: QwenAccount) {
    const accounts = loadQwenAccounts().filter(item => item.id !== account.id);
    accounts.push(account);
    saveQwenAccounts(accounts);
}

export function removeQwenAccount(id: string) {
    saveQwenAccounts(loadQwenAccounts().filter(a => a.id !== id));
    fs.rmSync(path.join(accountsDir, id), { recursive: true, force: true });
}

export function markQwenAccountInvalid(id: string) {
    const accounts = loadQwenAccounts();
    const account = accounts.find(a => a.id === id);
    if (account) account.invalid = true;
    saveQwenAccounts(accounts);
}

export function hasValidQwenAccounts() {
    return loadQwenAccounts().some(a =>
        !a.invalid && (!a.resetAt || new Date(a.resetAt).getTime() <= Date.now())
    );
}

export function getAvailableQwenAccount() {
    const available = loadQwenAccounts().filter(a =>
        !a.invalid && (!a.resetAt || new Date(a.resetAt).getTime() <= Date.now())
    );
    if (!available.length) return null;
    const account = available[pointer % available.length];
    pointer = (pointer + 1) % available.length;
    return account;
}
