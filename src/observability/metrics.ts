export interface RequestSample {
  provider: string;
  model: string;
  status: 'success' | 'error';
  latencyMs?: number;
}

export interface GaugeSnapshot {
  providers: Array<{ id: string; available: boolean }>;
  accounts: Array<{ provider: string; status: string }>;
  unavailableModels?: Array<{ model: string }>;
}

function label(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function labels(values: Record<string, string>) {
  return `{${Object.entries(values).map(([key, value]) => `${key}="${label(value)}"`).join(',')}}`;
}

export class Metrics {
  private readonly requests = new Map<string, { labels: Record<string, string>; count: number; seconds: number }>();

  record(sample: RequestSample) {
    const values = { provider: sample.provider, model: sample.model, status: sample.status };
    const key = labels(values);
    const entry = this.requests.get(key) ?? { labels: values, count: 0, seconds: 0 };
    entry.count += 1;
    entry.seconds += Math.max(sample.latencyMs ?? 0, 0) / 1000;
    this.requests.set(key, entry);
  }

  render(gauges: GaugeSnapshot) {
    const lines = [
      '# HELP gateway_requests_total Completed gateway requests by provider, model and status.',
      '# TYPE gateway_requests_total counter',
      ...[...this.requests.values()].map(entry => `gateway_requests_total${labels(entry.labels)} ${entry.count}`),
      '# HELP gateway_request_duration_seconds_sum Total duration of completed requests.',
      '# TYPE gateway_request_duration_seconds_sum counter',
      ...[...this.requests.values()].map(entry => `gateway_request_duration_seconds_sum${labels(entry.labels)} ${entry.seconds.toFixed(3)}`),
      '# HELP gateway_provider_available Whether a provider is currently available (1) or not (0).',
      '# TYPE gateway_provider_available gauge',
      ...gauges.providers.map(provider => `gateway_provider_available${labels({ provider: provider.id })} ${provider.available ? 1 : 0}`),
      '# HELP gateway_accounts Accounts by provider and status.',
      '# TYPE gateway_accounts gauge',
    ];
    const accounts = new Map<string, number>();
    for (const account of gauges.accounts) {
      const key = labels({ provider: account.provider, status: account.status });
      accounts.set(key, (accounts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of accounts) lines.push(`gateway_accounts${key} ${count}`);
    lines.push(
      '# HELP gateway_model_unavailable Models that failed as missing upstream and are hidden for a while.',
      '# TYPE gateway_model_unavailable gauge',
      ...(gauges.unavailableModels ?? []).map(entry => `gateway_model_unavailable${labels({ model: entry.model })} 1`),
    );
    return `${lines.join('\n')}\n`;
  }
}

const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function requestIdFrom(header: string | undefined) {
  return header && REQUEST_ID.test(header) ? header : crypto.randomUUID();
}
