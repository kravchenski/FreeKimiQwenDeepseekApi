#!/usr/bin/env bun

import { parseArgs } from 'node:util';

import { formatReport, listGatewayModels, probeModels } from '../src/cli/model-probe.ts';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: `http://localhost:${process.env.UNIFIED_PORT || 3260}/v1` },
    provider: { type: 'string', default: 'nvidia' },
    match: { type: 'string' },
    timeout: { type: 'string', default: '30' },
    concurrency: { type: 'string', default: '4' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`Usage: bun run models:probe [options]

Sends a one-word prompt to every model the running gateway lists and prints which ones answer.

  --provider <owner>   models of this owner only (default: nvidia, "all" for every model)
  --match <text>       only models whose id contains this text
  --timeout <seconds>  wait this long for the first chunk (default: 30)
  --concurrency <n>    parallel requests (default: 4, browser chats always run one at a time)
  --url <url>          gateway base URL (default: http://localhost:3260/v1)
  --json               print results as JSON`);
  process.exit(0);
}

const options = {
  baseUrl: values.url!.replace(/\/$/, ''),
  apiKey: process.env.GATEWAY_API_KEY || undefined,
  timeoutMs: Number(values.timeout) * 1000,
};

try {
  const models = (await listGatewayModels(options)).filter(model =>
    (values.provider === 'all' || model.ownedBy === values.provider) && (!values.match || model.id.includes(values.match)));
  if (!models.length) throw new Error(`No models match provider=${values.provider}${values.match ? ` match=${values.match}` : ''}`);
  const api = models.filter(model => model.ownedBy === 'nvidia');
  const web = models.filter(model => !api.includes(model));
  console.error(`Probing ${models.length} models (timeout ${values.timeout}s)…`);
  let done = 0;
  const progress = (result: { ok: boolean; model: string }) => {
    done += 1;
    console.error(`[${done}/${models.length}] ${result.ok ? '✓' : '✗'} ${result.model}`);
  };
  const results = [
    ...await probeModels(api, { ...options, concurrency: Number(values.concurrency) }, progress),
    ...await probeModels(web, { ...options, concurrency: 1 }, progress),
  ];
  console.log(values.json ? JSON.stringify(results, null, 2) : `\n${formatReport(results)}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
