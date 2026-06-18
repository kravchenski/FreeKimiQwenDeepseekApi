import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export const AGENT_IDS = [
    'pi',
    'opencode',
    'continue',
    'hermes',
    'aider',
    'codex',
    'claude',
    'cline',
    'generic'
] as const;

export type AgentId = typeof AGENT_IDS[number];

export type AgentSetupOptions = {
    agents: AgentId[];
    apiKey: string;
    baseUrl: string;
    bridgeUrl: string;
    dryRun: boolean;
    help: boolean;
    home: string;
};

export type InstallResult = {
    agent: AgentId | 'bundle';
    path: string;
    status: 'installed' | 'unchanged' | 'planned' | 'skipped';
    detail?: string;
};

const DEFAULT_BASE_URL = 'http://127.0.0.1:3263/api';
const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:4000';
const DEFAULT_API_KEY = 'dummy-key';
const DEFAULT_MODEL = 'qwen3-coder-plus';
const CODEX_CONTEXT_WINDOW = 131072;
const CODEX_AUTO_COMPACT_TOKEN_LIMIT = 98304;
const CODEX_TOOL_OUTPUT_TOKEN_LIMIT = 16384;
const AGENT_ALIASES: Record<string, AgentId> = {
    'pi-agent': 'pi',
    'open-code': 'opencode',
    'hermes-agent': 'hermes',
    'codex-cli': 'codex',
    'claude-code': 'claude',
    'cline-cli': 'cline',
    openwebui: 'generic',
    'open-webui': 'generic',
    roo: 'generic',
    'roo-code': 'generic',
    cursor: 'generic'
};

export function parseAgentSetupArgs(
    args: string[],
    environment: NodeJS.ProcessEnv = process.env
): AgentSetupOptions {
    const options: AgentSetupOptions = {
        agents: [...AGENT_IDS],
        apiKey: environment.FREEAI_API_KEY || DEFAULT_API_KEY,
        baseUrl: environment.FREEAI_URL || DEFAULT_BASE_URL,
        bridgeUrl: environment.FREEAI_BRIDGE_URL || DEFAULT_BRIDGE_URL,
        dryRun: false,
        help: false,
        home: environment.HOME || environment.USERPROFILE || homedir()
    };

    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        if (argument === '--all') options.agents = [...AGENT_IDS];
        else if (argument === '--dry-run') options.dryRun = true;
        else if (argument === '--help' || argument === '-h') options.help = true;
        else if (argument === '--agent') options.agents = parseAgentList(requireValue(args, ++index, argument));
        else if (argument.startsWith('--agent=')) options.agents = parseAgentList(argument.slice('--agent='.length));
        else if (argument === '--base-url') options.baseUrl = requireValue(args, ++index, argument);
        else if (argument.startsWith('--base-url=')) options.baseUrl = argument.slice('--base-url='.length);
        else if (argument === '--bridge-url') options.bridgeUrl = requireValue(args, ++index, argument);
        else if (argument.startsWith('--bridge-url=')) options.bridgeUrl = argument.slice('--bridge-url='.length);
        else if (argument === '--api-key') options.apiKey = requireValue(args, ++index, argument);
        else if (argument.startsWith('--api-key=')) options.apiKey = argument.slice('--api-key='.length);
        else if (argument === '--home') options.home = requireValue(args, ++index, argument);
        else if (argument.startsWith('--home=')) options.home = argument.slice('--home='.length);
        else throw new Error(`Unknown option: ${argument}`);
    }

    options.baseUrl = trimTrailingSlash(options.baseUrl);
    options.bridgeUrl = trimTrailingSlash(options.bridgeUrl);
    return options;
}

export async function loadAvailableModelIds(baseUrl: string, apiKey?: string): Promise<string[]> {
    try {
        const response = await fetch(`${trimTrailingSlash(baseUrl)}/models`, {
            headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
            signal: AbortSignal.timeout(2500)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        const ids = payload?.data
            ?.map((model: Record<string, unknown>) => model.id)
            .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
        if (ids?.length) return [...new Set<string>(ids)];
    } catch {
        // The setup command must also work before the gateway is started.
    }

    const qwen = (await readFile(new URL('../AvailableModels.txt', import.meta.url), 'utf8'))
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
    return [...new Set([
        ...qwen,
        'deepseek-default',
        'deepseek-reasoner',
        'deepseek-expert',
        'deepseek-search',
    ])];
}

export async function installAgentIntegrations(
    options: AgentSetupOptions,
    modelIds: string[]
): Promise<InstallResult[]> {
    const results: InstallResult[] = [];
    const paths = integrationPaths(options.home);

    if (options.agents.includes('pi')) {
        results.push(await updateJsonFile(paths.pi, options, 'pi', current => mergePiConfig(current, options, modelIds)));
    }
    if (options.agents.includes('opencode')) {
        results.push(await updateJsonFile(
            paths.opencode,
            options,
            'opencode',
            current => mergeOpenCodeConfig(current, options, modelIds)
        ));
    }
    if (options.agents.includes('continue')) {
        results.push(await updateYamlFile(
            paths.continue,
            options,
            'continue',
            current => mergeContinueConfig(current, options, modelIds)
        ));
    }
    if (options.agents.includes('hermes')) {
        results.push(await updateYamlFile(
            paths.hermes,
            options,
            'hermes',
            current => mergeHermesConfig(current, options, modelIds)
        ));
    }
    if (options.agents.includes('aider')) {
        results.push(await writeGeneratedFile(paths.aider, stringifyYaml({
            model: `openai/${preferredModel(modelIds)}`,
            'openai-api-base': options.baseUrl,
            'openai-api-key': options.apiKey
        }), options, 'aider'));
    }
    if (options.agents.includes('codex')) {
        results.push(...await installCodexProfiles(paths, options, modelIds));
    }
    if (options.agents.includes('claude')) {
        results.push(await writeGeneratedFile(
            paths.claude,
            `${JSON.stringify(claudeSettings(options), null, 2)}\n`,
            options,
            'claude'
        ));
    }
    if (options.agents.includes('cline')) {
        results.push(await writeGeneratedFile(
            paths.cline,
            clineInstructions(options, preferredModel(modelIds)),
            options,
            'cline'
        ));
    }
    if (options.agents.includes('generic')) {
        results.push(await writeGeneratedFile(paths.generic, genericEnvironment(options), options, 'generic'));
    }

    if (options.agents.some(agent => ['codex', 'claude', 'cline', 'generic'].includes(agent))) {
        results.push(await writeGeneratedFile(
            paths.litellm,
            stringifyYaml(liteLlmConfig(options, modelIds)),
            options,
            'bundle'
        ));
        results.push(await writeGeneratedFile(
            paths.readme,
            integrationReadme(options, paths, preferredModel(modelIds)),
            options,
            'bundle'
        ));
    }

    return results;
}

export function integrationPaths(home: string) {
    const bundle = join(home, '.freeqwenapi');
    return {
        aider: join(home, '.aider.freeqwenapi.yml'),
        claude: join(home, '.claude', 'freeai-settings.json'),
        cline: join(bundle, 'cline-auth.txt'),
        codex: join(home, '.codex', 'freeai.config.toml'),
        codexBase: join(home, '.codex', 'config.toml'),
        codexModels: join(home, '.codex', 'freeai-models.json'),
        continue: join(home, '.continue', 'config.yaml'),
        generic: join(bundle, 'openai.env'),
        hermes: join(home, '.hermes', 'config.yaml'),
        litellm: join(bundle, 'litellm.yaml'),
        opencode: join(home, '.config', 'opencode', 'opencode.json'),
        pi: join(home, '.pi', 'agent', 'models.json'),
        readme: join(bundle, 'README.md')
    };
}

export function agentSetupHelp() {
    return `Configure FreeQwenApi for popular AI agents.

Usage:
  bun run setup:agents
  bun run setup:agents -- --agent pi,opencode,hermes
  bun run setup:agents -- --dry-run

Options:
  --all                 Configure every supported integration (default)
  --agent <ids>         Comma-separated: ${AGENT_IDS.join(',')}
                        Common aliases such as claude-code, pi-agent, roo-code,
                        open-webui, cursor, and codex-cli are accepted
  --base-url <url>      OpenAI Chat Completions endpoint
  --bridge-url <url>    LiteLLM endpoint for Codex and Claude Code
  --api-key <key>       Local proxy or LiteLLM key
  --home <path>         Override the target home directory
  --dry-run             Show planned writes without changing files
  --help                Show this help
`;
}

function parseAgentList(value: string): AgentId[] {
    const requested = value.split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
    if (requested.includes('all')) return [...AGENT_IDS];
    const agents = [...new Set(requested.map(agent => AGENT_ALIASES[agent] || agent))];
    for (const agent of agents) {
        if (!AGENT_IDS.includes(agent as AgentId)) throw new Error(`Unknown agent: ${agent}`);
    }
    if (agents.length === 0) throw new Error('At least one agent is required');
    return agents as AgentId[];
}

function requireValue(args: string[], index: number, option: string) {
    const value = args[index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}`);
    return value;
}

function trimTrailingSlash(value: string) {
    return value.replace(/\/+$/, '');
}

function displayName(id: string) {
    return id
        .split('-')
        .map(part => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part)
        .join(' ');
}

function preferredModel(modelIds: string[]) {
    return modelIds.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : modelIds[0] || DEFAULT_MODEL;
}

function freeModel(id: string) {
    return {
        id,
        name: `Free ${displayName(id)}`,
        reasoning: id === 'deepseek-reasoner',
        input: ['text'],
        contextWindow: CODEX_CONTEXT_WINDOW,
        maxTokens: CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    };
}

function mergePiConfig(current: Record<string, any>, options: AgentSetupOptions, modelIds: string[]) {
    const config = { ...current, providers: { ...(current.providers || {}) } };
    config.providers.freeai = {
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        authHeader: true,
        api: 'openai-completions',
        compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            supportsUsageInStreaming: false,
            supportsStore: false,
            supportsStrictMode: false,
            maxTokensField: 'max_tokens',
            requiresToolResultName: true
        },
        models: modelIds.map(freeModel)
    };
    delete config.providers.freedeepseek;
    return config;
}

function mergeOpenCodeConfig(current: Record<string, any>, options: AgentSetupOptions, modelIds: string[]) {
    const config = { ...current, $schema: current.$schema || 'https://opencode.ai/config.json' };
    config.provider = { ...(current.provider || {}) };
    config.provider.freeai = {
        npm: '@ai-sdk/openai-compatible',
        name: 'FreeAI (Qwen + DeepSeek + Kimi)',
        options: {
            baseURL: options.baseUrl,
            apiKey: options.apiKey
        },
        models: Object.fromEntries(modelIds.map(id => [id, {
            name: displayName(id),
            limit: { context: 131072, output: 16384 }
        }]))
    };
    return config;
}

function mergeContinueConfig(current: Record<string, any>, options: AgentSetupOptions, modelIds: string[]) {
    const models = Array.isArray(current.models)
        ? current.models.filter((model: Record<string, any>) => !String(model?.name || '').startsWith('FreeAI '))
        : [];
    const freeModels = modelIds.map(id => ({
        name: `FreeAI ${displayName(id)}`,
        provider: 'openai',
        model: id,
        apiBase: options.baseUrl,
        apiKey: options.apiKey,
        capabilities: ['tool_use'],
        roles: ['chat', 'edit', 'apply'],
        defaultCompletionOptions: {
            contextLength: 131072,
            maxTokens: 16384
        }
    }));
    return {
        name: current.name || 'FreeAI local agents',
        version: current.version || '1.0.0',
        schema: current.schema || 'v1',
        ...current,
        models: [...models, ...freeModels]
    };
}

function mergeHermesConfig(current: Record<string, any>, options: AgentSetupOptions, modelIds: string[]) {
    const providers = Array.isArray(current.custom_providers)
        ? current.custom_providers.filter((provider: Record<string, any>) => provider?.name !== 'freeai')
        : [];
    return {
        ...current,
        custom_providers: [...providers, {
            name: 'freeai',
            base_url: options.baseUrl,
            api_key: options.apiKey,
            models: Object.fromEntries(modelIds.map(id => [id, { context_length: 131072 }]))
        }]
    };
}

function codexReasoningEffort(model: string) {
    if (model === 'deepseek-reasoner') return 'high';
    if (model.includes('qwq') || model.includes('qvq')) return 'medium';
    return 'none';
}

function codexModelCatalog(modelIds: string[]) {
    const baseInstructions = [
        'You are Codex, a coding agent.',
        'All tools included in the current request are available and callable.',
        'When the user asks to invoke, run, or use an available tool, call it immediately.',
        'Never claim that a supplied tool or MCP server is unavailable without first attempting the tool call.',
        'Bare MCP server labels such as mcp__playwright, mcp__context7, and mcp__exa are not tool names.',
        'For Playwright, call a concrete browser tool supplied in the current request, never the bare server label.',
        'Use the exact supplied tool name and valid arguments.'
    ].join(' ');
    const models = modelIds.map(id => {
        const effort = codexReasoningEffort(id);
        const supportsReasoning = effort !== 'none';
        return {
            slug: id,
            display_name: displayName(id),
            description: `FreeAI ${displayName(id)}`,
            default_reasoning_level: effort,
            supported_reasoning_levels: supportsReasoning
                ? [
                    { effort: 'low', description: 'Fast responses with lighter reasoning' },
                    { effort: 'medium', description: 'Balanced reasoning' },
                    { effort: 'high', description: 'Deeper reasoning' }
                ]
                : [],
            shell_type: 'shell_command',
            visibility: 'list',
            supported_in_api: true,
            priority: 1,
            additional_speed_tiers: [],
            service_tiers: [],
            upgrade: null,
            base_instructions: baseInstructions,
            model_messages: {
                instructions_template: '{{ base_instructions }}\n\n{{ developer_instructions }}',
                instructions_variables: {}
            },
            supports_reasoning_summaries: supportsReasoning,
            default_reasoning_summary: 'none',
            support_verbosity: true,
            default_verbosity: 'medium',
            apply_patch_tool_type: 'freeform',
            web_search_tool_type: 'text_and_image',
            truncation_policy: { mode: 'tokens', limit: 10000 },
            supports_parallel_tool_calls: true,
            supports_image_detail_original: true,
            experimental_supported_tools: [],
            context_window: CODEX_CONTEXT_WINDOW,
            max_context_window: CODEX_CONTEXT_WINDOW,
            auto_compact_token_limit: CODEX_AUTO_COMPACT_TOKEN_LIMIT,
            supports_search_tool: id.includes('search'),
            input_modalities: ['text']
        };
    });
    return `${JSON.stringify({ models }, null, 2)}\n`;
}

function codexProfile(options: AgentSetupOptions, model: string) {
    const reasoningEffort = codexReasoningEffort(model);
    return `# FreeQwenApi exposes a native Responses bridge that preserves MCP namespaces.
model = "${model}"
model_provider = "freeai"
model_catalog_json = "${escapeDoubleQuoted(integrationPaths(options.home).codexModels)}"
model_context_window = ${CODEX_CONTEXT_WINDOW}
model_auto_compact_token_limit = ${CODEX_AUTO_COMPACT_TOKEN_LIMIT}
tool_output_token_limit = ${CODEX_TOOL_OUTPUT_TOKEN_LIMIT}
${reasoningEffort === 'none' ? '' : `model_reasoning_effort = "${reasoningEffort}"\n`}

[model_providers.freeai]
name = "FreeAI Responses Bridge"
base_url = "${options.baseUrl}/v1"
env_key = "FREEAI_API_KEY"
wire_api = "responses"
`;
}

const MANAGED_BLOCK_START = '# >>> FreeQwenApi managed block >>>';
const MANAGED_BLOCK_END = '# <<< FreeQwenApi managed block <<<';

async function installCodexProfiles(
    paths: ReturnType<typeof integrationPaths>,
    options: AgentSetupOptions,
    modelIds: string[]
): Promise<InstallResult[]> {
    let baseConfig = '';
    try {
        baseConfig = await readFile(paths.codexBase, 'utf8');
    } catch (error) {
        if (!isMissingFile(error)) throw error;
    }

    const results: InstallResult[] = [];
    const baseCatalogConfig = `model_catalog_json = "${escapeDoubleQuoted(paths.codexModels)}"`;
    results.push(await writeGeneratedFile(
        paths.codexBase,
        mergeManagedBlock(removeManagedBlock(baseConfig), baseCatalogConfig),
        options,
        'codex'
    ));
    results.push(await writeGeneratedFile(paths.codexModels, codexModelCatalog(modelIds), options, 'codex'));
    results.push(await writeGeneratedFile(paths.codex, codexProfile(options, preferredModel(modelIds)), options, 'codex'));
    for (const model of modelIds) {
        results.push(await writeGeneratedFile(
            codexModelProfilePath(options.home, model),
            codexProfile(options, model),
            options,
            'codex'
        ));
    }
    return results;
}

function mergeManagedBlock(existing: string, content: string) {
    const block = `${MANAGED_BLOCK_START}\n${content.trim()}\n${MANAGED_BLOCK_END}\n`;
    const start = existing.indexOf(MANAGED_BLOCK_START);
    const end = existing.indexOf(MANAGED_BLOCK_END);

    if (start >= 0 && end >= start) {
        const suffixStart = end + MANAGED_BLOCK_END.length;
        return `${existing.slice(0, start)}${block}${existing.slice(suffixStart).replace(/^\n+/, '')}`;
    }
    return existing.trim() ? `${existing.trimEnd()}\n\n${block}` : block;
}

function removeManagedBlock(existing: string) {
    const start = existing.indexOf(MANAGED_BLOCK_START);
    const end = existing.indexOf(MANAGED_BLOCK_END);
    if (start < 0 || end < start) return existing;

    const suffixStart = end + MANAGED_BLOCK_END.length;
    const merged = `${existing.slice(0, start).trimEnd()}\n${existing.slice(suffixStart).trimStart()}`;
    return merged.trim() ? `${merged.trim()}\n` : '';
}

function claudeSettings(options: AgentSetupOptions) {
    return {
        env: {
            ANTHROPIC_BASE_URL: options.bridgeUrl,
            ANTHROPIC_AUTH_TOKEN: options.apiKey,
            CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1'
        }
    };
}

function clineInstructions(options: AgentSetupOptions, model: string) {
    return `Cline CLI:
cline auth -p openai -k "${escapeDoubleQuoted(options.apiKey)}" -b "${escapeDoubleQuoted(options.baseUrl)}" -m "${escapeDoubleQuoted(model)}"

Cline extension:
1. Select "OpenAI Compatible".
2. Base URL: ${options.baseUrl}
3. API key: ${options.apiKey}
4. Model ID: ${model}
`;
}

function escapeDoubleQuoted(value: string) {
    return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function genericEnvironment(options: AgentSetupOptions) {
    return `OPENAI_API_BASE=${options.baseUrl}
OPENAI_BASE_URL=${options.baseUrl}
OPENAI_API_KEY=${options.apiKey}
FREEAI_URL=${options.baseUrl}
FREEAI_API_KEY=${options.apiKey}
`;
}

function liteLlmConfig(options: AgentSetupOptions, modelIds: string[]) {
    return {
        model_list: modelIds.map(id => ({
            model_name: id,
            litellm_params: {
                model: `openai/chat_completions/${id}`,
                api_base: options.baseUrl,
                api_key: options.apiKey
            }
        })),
        general_settings: {
            master_key: options.apiKey
        }
    };
}

function codexModelProfilePath(home: string, model: string) {
    return join(home, '.codex', `${codexProfileName(model)}.config.toml`);
}

function codexProfileName(model: string) {
    return `freeai-${model.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

function integrationReadme(options: AgentSetupOptions, paths: ReturnType<typeof integrationPaths>, model: string) {
    return `# FreeQwenApi Agent Integrations

Direct OpenAI Chat Completions endpoint: \`${options.baseUrl}\`
LiteLLM bridge endpoint: \`${options.bridgeUrl}\`

## Direct integrations

- Pi Agent: \`pi --provider freeai --model ${model}\`
- OpenCode: run \`opencode\`, then select \`freeai/${model}\` from \`/models\`
- Continue: select \`FreeAI ${displayName(model)}\`
- Hermes: \`hermes chat --provider custom:freeai --model ${model}\`
- Aider: \`aider --config "${paths.aider}"\`
- Cline: follow \`${paths.cline}\`

## Responses integrations

Codex uses the native FreeQwenApi Responses bridge, which preserves MCP tool
namespaces. Run:

\`\`\`text
FREEAI_API_KEY=${options.apiKey} codex -p freeai -m ${model}
FREEAI_API_KEY=${options.apiKey} codex -p ${codexProfileName(model)}
\`\`\`

Codex profiles are generated for every model as \`freeai-<model>\`, for example
\`codex -p freeai-deepseek-reasoner\`.

On PowerShell, set \`$env:FREEAI_API_KEY="${options.apiKey}"\` before starting Codex.

Claude Code can still use the optional LiteLLM bridge:

\`\`\`text
uvx --from "litellm[proxy]" litellm --config "${paths.litellm}" --host 127.0.0.1 --port 4000
claude --settings "${paths.claude}" --model ${model}
\`\`\`

## GUI clients

For Open WebUI, Cline, Roo Code, and other OpenAI-compatible clients use:

- Base URL: \`${options.baseUrl}\`
- API key: \`${options.apiKey}\`
- Model: \`${model}\`

Cursor may send Responses API requests and is not guaranteed to work directly with this gateway.
`;
}

async function updateJsonFile(
    path: string,
    options: AgentSetupOptions,
    agent: AgentId,
    merge: (current: Record<string, any>) => Record<string, any>
): Promise<InstallResult> {
    let current: Record<string, any> = {};
    try {
        current = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
        if (!isMissingFile(error)) {
            return {
                agent,
                path,
                status: 'skipped',
                detail: 'Existing config is not valid JSON; left unchanged'
            };
        }
    }
    return writeGeneratedFile(path, `${JSON.stringify(merge(current), null, 2)}\n`, options, agent);
}

async function updateYamlFile(
    path: string,
    options: AgentSetupOptions,
    agent: AgentId,
    merge: (current: Record<string, any>) => Record<string, any>
): Promise<InstallResult> {
    let current: Record<string, any> = {};
    try {
        current = parseYaml(await readFile(path, 'utf8')) || {};
    } catch (error) {
        if (!isMissingFile(error)) {
            return {
                agent,
                path,
                status: 'skipped',
                detail: 'Existing config is not valid YAML; left unchanged'
            };
        }
    }
    return writeGeneratedFile(path, stringifyYaml(merge(current)), options, agent);
}

async function updateManagedTextFile(
    path: string,
    content: string,
    options: AgentSetupOptions,
    agent: AgentId
): Promise<InstallResult> {
    let existing = '';
    try {
        existing = await readFile(path, 'utf8');
    } catch (error) {
        if (!isMissingFile(error)) throw error;
    }
    return writeGeneratedFile(path, mergeManagedBlock(existing, content), options, agent);
}

async function writeGeneratedFile(
    path: string,
    content: string,
    options: AgentSetupOptions,
    agent: AgentId | 'bundle'
): Promise<InstallResult> {
    let existing: string | null = null;
    try {
        existing = await readFile(path, 'utf8');
    } catch (error) {
        if (!isMissingFile(error)) throw error;
    }
    if (existing === content) return { agent, path, status: 'unchanged' };
    if (options.dryRun) return { agent, path, status: 'planned' };

    await mkdir(dirname(path), { recursive: true });
    if (existing !== null) await createBackup(path);
    await writeFile(path, content);
    return { agent, path, status: 'installed' };
}

async function createBackup(path: string) {
    try {
        await copyFile(path, `${path}.freeqwenapi.bak`, constants.COPYFILE_EXCL);
    } catch (error) {
        if (!isExistingFile(error)) throw error;
    }
}

function isMissingFile(error: unknown) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function isExistingFile(error: unknown) {
    return (error as NodeJS.ErrnoException)?.code === 'EEXIST';
}
