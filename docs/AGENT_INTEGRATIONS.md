# AI Agent Integrations

FreeQwenApi includes one cross-platform setup command for popular coding agents:

```text
bun run setup:agents -- --dry-run
bun run setup:agents
```

The installer discovers models from the running unified gateway and falls back
to the repository model list when the gateway is offline. It never silently
replaces malformed configs, preserves unrelated settings, and creates the first
changed version as `<config>.freeqwenapi.bak`.

It configures agents that are already installed; it does not download or update
third-party agent executables.

## Supported Agents

| Agent or client | Mode | Installer result |
| --- | --- | --- |
| Pi Agent | Direct | Merges all models into `~/.pi/agent/models.json` |
| OpenCode | Direct | Merges a `freeai` provider into `~/.config/opencode/opencode.json` |
| Continue | Direct | Merges models into `~/.continue/config.yaml` |
| Hermes Agent | Direct | Merges a named custom provider into `~/.hermes/config.yaml` |
| Aider | Direct | Creates `~/.aider.freeqwenapi.yml` |
| Cline CLI and extension | Direct | Creates setup commands under `~/.freeqwenapi/` |
| Open WebUI and Roo Code | Direct | Uses the generated generic OpenAI-compatible settings |
| Codex CLI | LiteLLM bridge | Creates `~/.codex/freeai.config.toml` |
| Claude Code | LiteLLM bridge | Creates `~/.claude/freeai-settings.json` |
| Cursor | Limited | Generic settings are documented, but direct compatibility is not guaranteed |

Codex uses the OpenAI Responses API and Claude Code uses the Anthropic Messages
API. FreeQwenApi exposes OpenAI Chat Completions, so those two agents require the
generated LiteLLM bridge configuration.

## Installer Options

```text
bun run setup:agents -- --agent pi,opencode,hermes
bun run setup:agents -- --agent claude-code,roo-code
bun run setup:agents -- --agent codex
bun run setup:agents -- --base-url http://127.0.0.1:3263/api
bun run setup:agents -- --bridge-url http://127.0.0.1:4000
bun run setup:agents -- --api-key dummy-key
bun run setup:agents -- --home /custom/home
bun run setup:agents -- --help
```

The same commands work in Bash, zsh, PowerShell, and Command Prompt.

## Direct Agents

After running the installer:

```text
pi --provider freeai --model qwen3-coder-plus
opencode
hermes chat --provider custom:freeai --model qwen3-coder-plus
aider --config ~/.aider.freeqwenapi.yml
```

OpenCode exposes the provider as `freeai`; select models with `/models`.
Continue exposes entries prefixed with `FreeAI`.

Cline CLI can be configured with the command generated in
`~/.freeqwenapi/cline-auth.txt`. In Cline, Roo Code, and Open WebUI use:

| Setting | Value |
| --- | --- |
| Provider | OpenAI Compatible |
| Base URL | `http://127.0.0.1:3263/api` |
| API key | `dummy-key` |
| Model | `qwen3-coder-plus`, `deepseek-default`, or another listed model |

## Codex And Claude Code

Start a LiteLLM proxy with the generated bridge configuration:

```text
uvx --from "litellm[proxy]" litellm --config ~/.freeqwenapi/litellm.yaml --host 127.0.0.1 --port 4000
```

Then start Codex:

```text
FREEAI_API_KEY=dummy-key codex -p freeai -m qwen3-coder-plus
```

The installer preserves `~/.codex/config.toml`, migrates its old managed block,
and updates only `~/.codex/freeai.config.toml` on subsequent runs.

It also creates one profile per generated model:

```text
codex -p freeai-qwen3-coder-plus
codex -p freeai-deepseek-reasoner
```

Every generated profile includes manual context-window metadata and inherits
MCP servers from the base Codex config.

PowerShell:

```powershell
$env:FREEAI_API_KEY = "dummy-key"
codex -p freeai -m qwen3-coder-plus
```

Start Claude Code:

```text
claude --settings ~/.claude/freeai-settings.json --model qwen3-coder-plus
```

## Generated Files

The installer always preserves unrelated configuration keys. Generated bridge
and reference files live under `~/.freeqwenapi/`:

```text
~/.freeqwenapi/
├── README.md
├── cline-auth.txt
├── litellm.yaml
└── openai.env
```

Use `bun run setup:pi` when only Pi Agent needs to be synchronized.

## Upstream References

- [Codex configuration reference](https://developers.openai.com/codex/config-reference)
- [Claude Code LLM gateway configuration](https://code.claude.com/docs/en/llm-gateway)
- [OpenCode custom providers](https://opencode.ai/docs/providers)
- [Continue config.yaml reference](https://docs.continue.dev/reference)
- [Hermes custom providers](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/integrations/providers.md)
- [Aider OpenAI-compatible APIs](https://aider.chat/docs/llms/openai-compat.html)
- [Cline OpenAI-compatible provider](https://docs.cline.bot/provider-config/openai-compatible)
