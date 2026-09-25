import crypto from 'node:crypto';

const comparisonKey = crypto.randomBytes(32);

const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'content-length',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
]);

export function bearerToken(header: unknown) {
    if (typeof header !== 'string') return null;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match?.[1]?.trim() || null;
}

export function tokenMatches(token: string | null, expected: string | undefined) {
    if (!expected) return true;
    if (!token) return false;
    const actualDigest = crypto.createHmac('sha256', comparisonKey).update(token).digest();
    const expectedDigest = crypto.createHmac('sha256', comparisonKey).update(expected).digest();
    return crypto.timingSafeEqual(actualDigest, expectedDigest);
}

export function isForwardableResponseHeader(name: string) {
    return !HOP_BY_HOP_HEADERS.has(name.toLowerCase());
}
