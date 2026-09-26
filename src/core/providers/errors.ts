export type ProviderErrorKind = 'rate_limit' | 'quota_exhausted' | 'auth' | 'unavailable' | 'upstream';

const MAX_DETAIL_LENGTH = 500;
const QUOTA_PATTERN = /quota|insufficient|exceeded your|billing|balance|credit/i;
const EXPIRED_AUTH_PATTERN = /token (?:has )?expired|log ?in again|invalid (?:access )?token|not authenticated/i;

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: ProviderErrorKind,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function classifyStatus(status: number, body: string): ProviderErrorKind {
  if (status === 402) return 'quota_exhausted';
  if (status === 429) return QUOTA_PATTERN.test(body) ? 'quota_exhausted' : 'rate_limit';
  if (status === 401 || status === 403 || EXPIRED_AUTH_PATTERN.test(body)) return 'auth';
  if (status === 503) return 'unavailable';
  return 'upstream';
}

function retryAfterSeconds(header: string | null) {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(Math.ceil((date - Date.now()) / 1000), 0);
}

export async function upstreamError(action: string, response: Response) {
  const body = (await response.text().catch(() => '')).slice(0, MAX_DETAIL_LENGTH);
  return new ProviderError(
    `${action} failed: ${response.status} ${body}`,
    classifyStatus(response.status, body),
    response.status,
    retryAfterSeconds(response.headers.get('retry-after')),
  );
}

const HTTP_MAPPING: Record<ProviderErrorKind, { status: 429 | 502 | 503; type: string }> = {
  rate_limit: { status: 429, type: 'rate_limit_exceeded' },
  quota_exhausted: { status: 429, type: 'insufficient_quota' },
  auth: { status: 502, type: 'upstream_auth_error' },
  unavailable: { status: 503, type: 'provider_unavailable' },
  upstream: { status: 502, type: 'upstream_error' },
};

export function toHttpError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof ProviderError)) return { status: 502 as const, type: 'upstream_error', message };
  const { status, type } = HTTP_MAPPING[error.kind];
  return { status, type, message, retryAfterSeconds: error.retryAfterSeconds };
}
