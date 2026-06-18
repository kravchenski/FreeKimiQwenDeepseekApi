import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';

import {
    AGENT_IDS,
    installAgentIntegrations,
    integrationPaths,
    parseAgentSetupArgs,
    type AgentId
} from '../src/cli/agentSetup.ts';

describe('agent integration setup', () => {
    test('parses cross-platform setup options', () => {
        const options = parseAgentSetupArgs([
            '--agent=pi,opencode',
            '--base-url=http://localhost:9000/v1/',
            '--bridge-url',
            'http://localhost:4000/',
            '--dry-run'
        ], { HOME: '/tmp/example' });

        expect(options).toMatchObject({
            agents: ['pi', 'opencode'],
            baseUrl: 'http://localhost:9000/v1',
            bridgeUrl: 'http://localhost:4000',
            dryRun: true,
            home: '/tmp/example'
        });
        expect(parseAgentSetupArgs(['--agent', 'claude-code,roo-code']).agents).toEqual(['claude', 'generic']);
        expect(parseAgentSetupArgs(['--agent', 'all']).agents).toEqual([...AGENT_IDS]);
        expect(() => parseAgentSetupArgs(['--agent', 'unknown'])).toThrow('Unknown agent');
    });

    test('merges direct configs, creates bridge profiles, and remains idempotent', async () => {
        const home = await mkdtemp(join(tmpdir(), 'freeqwenapi-agents-'));
        const paths = integrationPaths(home);
        const options = parseAgentSetupArgs(['--all', '--home', home]);
        const models = ['qwen3-coder-plus', 'qwen3.7-max', 'deepseek-default', 'deepseek-reasoner'];

        try {
            await mkdir(join(home, '.pi', 'agent'), { recursive: true });
            await writeFile(paths.pi, `${JSON.stringify({ theme: 'dark', providers: { existing: {} } })}\n`);
            await mkdir(join(home, '.continue'), { recursive: true });
            await writeFile(paths.continue, 'name: Existing\nversion: 1.0.0\nschema: v1\nrules:\n  - Keep this\n');
            await mkdir(join(home, '.codex'), { recursive: true });
            await writeFile(
                paths.codexBase,
                `approval_policy = "on-request"\n\n# >>> FreeQwenApi managed block >>>\n[profiles.freeai]\nmodel = "old"\n# <<< FreeQwenApi managed block <<<\n`
            );

            const results = await installAgentIntegrations(options, models);
            expect(results.some(result => result.agent === 'codex' && result.status === 'installed')).toBeTrue();
            expect(results.some(result => result.agent === 'bundle' && result.status === 'installed')).toBeTrue();

            const pi = JSON.parse(await readFile(paths.pi, 'utf8'));
            expect(pi.theme).toBe('dark');
            expect(pi.providers.existing).toEqual({});
            expect(pi.providers.freeai.models.map((model: Record<string, string>) => model.id)).toEqual(models);

            const openCode = JSON.parse(await readFile(paths.opencode, 'utf8'));
            expect(Object.keys(openCode.provider.freeai.models)).toEqual(models);
            expect(openCode.provider.freeai.options.baseURL).toBe('http://127.0.0.1:3263/api');

            const continueConfig = parseYaml(await readFile(paths.continue, 'utf8'));
            expect(continueConfig.rules).toEqual(['Keep this']);
            expect(continueConfig.models).toHaveLength(models.length);

            const hermes = parseYaml(await readFile(paths.hermes, 'utf8'));
            expect(hermes.custom_providers[0].name).toBe('freeai');
            expect(Object.keys(hermes.custom_providers[0].models)).toEqual(models);

            expect(await readFile(`${paths.pi}.freeqwenapi.bak`, 'utf8')).toContain('"theme":"dark"');
            expect(await readFile(paths.codex, 'utf8')).toContain('wire_api = "responses"');
            expect(await readFile(paths.codex, 'utf8')).toContain('base_url = "http://127.0.0.1:3263/api/v1"');
            expect(await readFile(paths.codex, 'utf8')).not.toContain('127.0.0.1:4000');
            expect(await readFile(paths.codex, 'utf8')).toContain('model_catalog_json = "');
            expect(await readFile(paths.codex, 'utf8')).not.toContain('[profiles.freeai]');
            expect(await readFile(paths.codexBase, 'utf8')).toContain('approval_policy = "on-request"');
            expect(await readFile(paths.codexBase, 'utf8')).not.toContain('[profiles.freeai]');
            expect(await readFile(paths.codexBase, 'utf8')).toContain('model_catalog_json = "');
            expect(await readFile(`${paths.codexBase}.freeqwenapi.bak`, 'utf8')).toContain('[profiles.freeai]');
            expect(await readFile(paths.claude, 'utf8')).toContain('ANTHROPIC_BASE_URL');
            expect(await readFile(paths.codex, 'utf8')).toContain('model_context_window = 131072');
            expect(await readFile(join(home, '.codex', 'freeai-deepseek-default.config.toml'), 'utf8')).toContain(
                'model = "deepseek-default"'
            );
            const codexCatalog = JSON.parse(await readFile(paths.codexModels, 'utf8'));
            const qwenCatalogModel = codexCatalog.models.find((model: Record<string, any>) => model.slug === 'qwen3.7-max');
            expect(qwenCatalogModel.context_window).toBe(131072);
            expect(qwenCatalogModel.base_instructions).toContain('Never claim that a supplied tool or MCP server is unavailable');

            const liteLlm = parseYaml(await readFile(paths.litellm, 'utf8'));
            expect(liteLlm.model_list[0].litellm_params.model).toBe(
                'openai/chat_completions/qwen3-coder-plus'
            );

            const secondResults = await installAgentIntegrations(options, models);
            expect(secondResults.every(result => result.status === 'unchanged')).toBeTrue();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });

    test('dry run plans writes without touching the target home', async () => {
        const home = await mkdtemp(join(tmpdir(), 'freeqwenapi-agents-dry-'));
        const agents: AgentId[] = [...AGENT_IDS];
        try {
            const results = await installAgentIntegrations({
                ...parseAgentSetupArgs(['--home', home]),
                agents,
                dryRun: true
            }, ['qwen3-coder-plus']);
            expect(results.every(result => result.status === 'planned')).toBeTrue();
            expect(readFile(integrationPaths(home).pi, 'utf8')).rejects.toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });

    test('does not overwrite malformed user configs', async () => {
        const home = await mkdtemp(join(tmpdir(), 'freeqwenapi-agents-invalid-'));
        const paths = integrationPaths(home);
        try {
            await mkdir(join(home, '.config', 'opencode'), { recursive: true });
            await writeFile(paths.opencode, '{ invalid json');
            const options = parseAgentSetupArgs(['--agent', 'opencode', '--home', home]);
            const results = await installAgentIntegrations(options, ['qwen3-coder-plus']);
            expect(results).toEqual([{
                agent: 'opencode',
                path: paths.opencode,
                status: 'skipped',
                detail: 'Existing config is not valid JSON; left unchanged'
            }]);
            expect(await readFile(paths.opencode, 'utf8')).toBe('{ invalid json');
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });
});
