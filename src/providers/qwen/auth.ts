import crypto from 'node:crypto';

export interface QwenSession {
  token: string;
  expiresAt?: number;
  cookies?: Array<{ name: string; value: string; domain: string }>;
}

const DEFAULT_BASE_URL = 'https://chat.qwen.ai';

export function jwtExpiry(token: string) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export function parseSignInResponse(status: number, body: any): QwenSession {
  const payload = body?.data && typeof body.data === 'object' ? { ...body, ...body.data } : body ?? {};
  const token = payload.token ?? payload.access_token;
  if (status >= 400 || body?.success === false || typeof token !== 'string' || !token) {
    const detail = [payload.detail, payload.details, payload.message, payload.code].find(value => typeof value === 'string') ?? 'no token in response';
    throw new Error(`Qwen sign-in failed: ${status} ${detail}`);
  }
  const expiresAt = typeof payload.expires_at === 'number' ? payload.expires_at * 1000 : jwtExpiry(token);
  return { token, expiresAt };
}

export async function qwenSignIn(
  email: string,
  password: string,
  options: { baseUrl?: string; fetch?: typeof fetch } = {},
): Promise<QwenSession> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const response = await (options.fetch ?? fetch)(`${baseUrl}/api/v2/auths/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl, Referer: `${baseUrl}/auth?action=signin` },
    body: JSON.stringify({ email, password: crypto.createHash('sha256').update(password).digest('hex') }),
    signal: AbortSignal.timeout(20_000),
  });
  return parseSignInResponse(response.status, await response.json().catch(() => ({})));
}
