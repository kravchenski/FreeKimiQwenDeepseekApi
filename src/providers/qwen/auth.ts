import crypto from 'node:crypto';

export interface QwenSession {
  token: string;
  expiresAt?: number;
}

const DEFAULT_BASE_URL = 'https://chat.qwen.ai';

function jwtExpiry(token: string) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export async function qwenSignIn(
  email: string,
  password: string,
  options: { baseUrl?: string; fetch?: typeof fetch } = {},
): Promise<QwenSession> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const response = await (options.fetch ?? fetch)(`${baseUrl}/api/v1/auths/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl, Referer: `${baseUrl}/auth?action=signin` },
    body: JSON.stringify({ email, password: crypto.createHash('sha256').update(password).digest('hex') }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({})) as { token?: unknown; expires_at?: unknown; detail?: unknown };
  if (!response.ok || typeof body.token !== 'string' || !body.token) {
    const detail = typeof body.detail === 'string' ? body.detail : 'no token in response';
    throw new Error(`Qwen sign-in failed for ${email}: ${response.status} ${detail}`);
  }
  const expiresAt = typeof body.expires_at === 'number' ? body.expires_at * 1000 : jwtExpiry(body.token);
  return { token: body.token, expiresAt };
}
