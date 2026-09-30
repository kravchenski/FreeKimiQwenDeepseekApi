<div align="center">

# FreeQwenApi

**Free local gateway for DeepSeek, GLM and Kimi web chats and NVIDIA models — OpenAI-compatible endpoint for OpenCode, Continue, Cline, Aider and any AI agent.**

[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun&logoColor=000)](https://bun.sh)
[![OpenAI compatible](https://img.shields.io/badge/API-OpenAI%20compatible-412991)](#api-reference)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[Quick Start](#quick-start) · [Models](#models) · [API](#api-reference) · [Docker](#docker)

</div>

FreeQwenApi is a local gateway for [DeepSeek Web](https://chat.deepseek.com/), [GLM (chat.z.ai)](https://chat.z.ai/), [Kimi](https://www.kimi.ai/) and [NVIDIA API](https://build.nvidia.com) models with an OpenAI-compatible API.

## Quick Start

```bash
git clone https://github.com/kravchenski/FreeQwenApi.git
cd FreeQwenApi
bun install
bun run start
```

**Server:** `http://localhost:3260`

## Models

| Provider | Models | Key |
|----------|--------|-----|
| **Auto** | `auto` — web chats first, then discovered NVIDIA models, each ordered by measured response time; override with `AUTO_MODELS` | — |
| **DeepSeek** | `deepseek-default`, `deepseek-reasoner`, `deepseek-expert`, `deepseek-search` | `bun run auth:deepseek` |
| **Qwen / GLM / Kimi / Arena web chat** | `qwen-chat` (chat.qwen.ai), `glm-chat` (chat.z.ai), `kimi-chat` (kimi.ai), `arena-chat` (arena.ai, sign-in optional) — sent through your signed-in browser; `bun run account status` shows which chats are signed in | `bun run account open <url>` |
| **NVIDIA** | every chat model your key can see (`deepseek-ai/*`, `moonshotai/*`, `z-ai/*`, `meta/*`, `mistralai/*`, …); models missing for your account are hidden after the first 404 | `NVIDIA_API_KEY` or `bun run account add nvidia --api-key` |
| **OpenRouter** | free models only, as `openrouter/<model>:free` | `OPENROUTER_API_KEY` or `bun run account add openrouter --api-key` |
| **Groq, Google Gemini, Cerebras, Mistral, SambaNova** | every chat model on their free tiers, as `groq/<model>`, `gemini/<model>`, `cerebras/<model>`, `mistral/<model>`, `sambanova/<model>` | `<PROVIDER>_API_KEY` or `bun run account add <provider> --api-key` |
| **GitHub Models, Hugging Face, Zhipu BigModel, Cohere, Aion Labs, LLM7.io** | their free tier models, as `github-models/<model>`, `huggingface/<model>`, `bigmodel/<flash model>`, `cohere/<model>`, `aion/<model>`, `llm7/<model>` | `<PROVIDER>_API_KEY` or `bun run account add <provider> --api-key` |
| **Z.AI, Ollama Cloud, OpenCode Zen** | free flash GLM models as `zai/<model>`, Ollama Cloud models as `ollama-cloud/<model>`, free Zen models as `opencode-zen/<model>-free` | `<PROVIDER>_API_KEY` or `bun run account add <provider> --api-key` |
| **Cloudflare Workers AI** | Workers AI models as `cloudflare/@cf/<model>` (10,000 free neurons a day) | `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID`, or `bun run account add cloudflare --api-key` (asks for the Account ID) |
| **xKiro** | third-party gateway; only its free models, as `xkiro/<model>`; not used by `model=auto` until you turn it on | `XKIRO_API_KEY` or `bun run account add xkiro --api-key` |
| **Kilo Gateway** | free models only, as `kilo/<model>:free` and `kilo/kilo-auto/free`; works without a key | optional `KILO_API_KEY` |
| **OVHcloud AI Endpoints** | open-weight models hosted in the EU, as `ovhcloud/<model>`; works without a key at 2 requests per minute | optional `OVHCLOUD_API_KEY` |

All models are free. The API providers are fallbacks after the web chats and each needs its own free API key; providers without a key are skipped.

Run `bun run account` to see every provider, whether it is connected and the command that connects it (`--json` for scripts).

### Several accounts for the web chats

Each browser account is its own browser profile. Sign it in to Google once and use "Sign in with Google" on every web chat; requests to `qwen-chat`, `glm-chat` and `kimi-chat` then rotate between the signed-in accounts and fall through to the next one when an account is signed out, limited or asked for a verification. The existing profile is the account `Main`.

```bash
bun run account profile add Work          # create an account
bun run account connect --profile <id>    # open Google and every web chat in it, then check the sign-ins
bun run account profiles                  # list accounts (--json for scripts)
bun run account status                    # check every account
bun run account profile remove <id>
```

The desktop app does the same on the Accounts page (Add account, Connect chats, Check, Remove). Stop the API before connecting or checking, because it uses the same browser profiles.

### Tuning `auto`

`bun run account auto --focus coding` makes `model=auto` prefer models made for the task (`general`, `coding`, `reasoning`, `fast`); `--mode race` sends each request to the first three models of the chain at the same time and keeps the first answer (`fallback`, the default, tries them one by one); `--mode decide` lets a fast decision model read each request and pick the model that suits it (a large model for coding or reasoning, a small one for small talk), keeping the rest of the chain as backup. Modes only change chat requests; images are not affected. The desktop app has the same options, plus a light, dark or system theme, on its Settings page.

To keep a provider out of `model=auto` without disconnecting it, run `bun run account provider <id> --auto off` (or use the switch on the provider's page in the desktop app).

To see which models actually answer for your keys and accounts, run `bun run models:probe` while the gateway is running (`--provider all` includes web chats, `--help` for options). The gateway remembers every measurement in `data/gateway.db`, so a probe run also reorders `auto` with the fastest working models first.

```bash
curl http://localhost:3260/v1/models
```

### Coding agents

Requests that carry tools (Claude Code, Codex, pi, OpenCode and other agents) get three extra steps, each switchable with `bun run account auto --<option> on|off` or on the desktop Settings page:

| Option | Default | What it does |
|---|---|---|
| `--compact` | on | Trims tool output the agent sends back: colours, progress redraws and repeated lines go, very long output keeps its start, its end and every error or warning line. |
| `--tools` | on | With more than 15 tools, the decision model keeps only the ones the task needs; core tools (read, edit, write, shell, search) and tools already used stay. The answer is cached per task. |
| `--rtk` | off | Rewrites the agent's shell commands with the installed [rtk](https://github.com/rtk-ai/rtk) (`git status` → `rtk git status`), so their output comes back compact. Needs `rtk` on the machine that runs the gateway and the agent. |

The response headers `x-gateway-compacted`, `x-gateway-tools` and `x-gateway-rtk` and the entries in `/v1/gateway/decisions` show what was saved.

## First Request

```bash
curl http://localhost:3260/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-default",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/v1/models` | List models |
| `POST` | `/v1/chat/completions` | Chat Completions (streaming + non-streaming) |
| `POST` | `/v1/decisions` (also `/v1/systemone`) | Decision API in TypeSafe's System One shape (as used by Jev): `state` plus `questions` of type `choice` (with `criteria`), `noul` or `boolean`; answers carry `choice`, `confidence` and `probabilities`, or `noul` / `probability`. Answered by the fastest strong free API model |
| `GET` | `/v1/gateway/decisions` | Recent routing decisions, newest first: requested model, mode (`direct`, `fallback`, `race`, `decide`), the decision model's pick and how long it took (`decisionMs`), skipped candidates with the reason, every attempt with its outcome and latency, and the chosen route (`?limit=`, `?model=`) |
| `GET` | `/v1/images/models` | List image models |
| `POST` | `/v1/images/generations` | OpenAI Images API: `prompt`, optional `model`, `size` (`WIDTHxHEIGHT`), `n` (1–4), `response_format` (`url` or `b64_json`) |
| `GET` | `/health` | Server status |

Image models: `qwen-chat/image` (your signed-in Qwen Chat, up to 2688×1536), `cloudflare/@cf/<model>` (FLUX and SDXL with the Cloudflare key) and `pollinations/<model>` (no key, watermarked). Without a `model` the first available one is used and the next is tried when it fails.

DeepSeek supports tool calls. Web providers (DeepSeek) work through browser (Puppeteer) and support streaming. NVIDIA providers use `https://integrate.api.nvidia.com/v1`.

## Commands

| Command | Description |
|---------|-------------|
| `bun run start` | Start unified server (port 3260) |
| `bun run dev` | Start with watch mode |
| `bun run auth:deepseek` | Manage DeepSeek accounts |
| `bun run account` | Show providers; save API keys (`add nvidia --api-key`, `list`, `remove`); web chat sign-in (`open`, `status`) |
| `bun run test` | Run tests |
| `bun run check` | Validate build |

## Docker

```bash
docker compose up -d
```

Starts the unified API on `127.0.0.1:3260` using `.env` for keys and mounting `session/`, `data/` and `logs/`. Add accounts on the host (`bun run account ...`) before starting. The old per-provider services are available with `docker compose --profile legacy up -d`.

## Monitoring

- `GET /v1/gateway/status` — providers, account states and recent requests (JSON)
- `GET /metrics` — Prometheus metrics: `gateway_requests_total`, `gateway_request_duration_seconds_sum`, `gateway_provider_available`, `gateway_accounts`
- Every response carries `x-request-id` (a safe incoming value is kept, otherwise one is generated)

Both endpoints require the bearer token when `GATEWAY_API_KEY` is set.

## Releases

Versions follow [Semantic Versioning](https://semver.org) and are derived from [Conventional Commits](https://www.conventionalcommits.org) by [release-please](https://github.com/googleapis/release-please): `feat` → minor, `fix` / `perf` / `refactor` → patch, `!` or `BREAKING CHANGE` → major. Every push to `main` updates a release PR; merging it creates the `vX.Y.Z` tag, a GitHub Release listing the commits in that version, updates `CHANGELOG.md`, publishes `ghcr.io/<owner>/freeqwenapi:X.Y.Z` and attaches desktop installers: `free-ai-gateway-X.Y.Z-linux-x64.deb`, `free-ai-gateway-X.Y.Z-macos-arm64.dmg` and `free-ai-gateway-X.Y.Z-windows-x64-setup.exe`.

The installers bundle the gateway and the accounts CLI as standalone binaries, so Bun is not required. Chrome or Chromium must be installed for the web chats. The installed app keeps its `.env`, `data/`, `session/` and `logs/` in `~/.local/share/free-ai-gateway` (Linux), `~/Library/Application Support/Free AI Gateway` (macOS) or `%APPDATA%\Free AI Gateway` (Windows). Running the desktop app from a clone (`cd desktop && cargo run`, or `FREEAPI_ROOT=<clone>`) still uses the repository with Bun. The installers are not code-signed yet, so macOS and Windows show a warning on first launch.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `UNIFIED_PORT` | `3260` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `NVIDIA_API_KEY` | - | NVIDIA API key; overrides a key saved with `bun run account add nvidia --api-key` |
| `ACCOUNTS_SECRET` | system keyring | Encrypts the credential registry `session/credentials.enc`. `bun run account init` stores it in the OS keyring (Secret Service, Keychain, Credential Manager) and moves it out of `.env`; set the variable only where no keyring exists (Docker, CI) |

## Project Structure

```
src/
  unified/server.ts      — main server (all providers)
  providers/             — provider clients (deepseek/, glm/, kimi/, OpenAI-compatible NVIDIA catalog)
  api/                   — API routes and chat logic
  browser/               — Puppeteer browser
  web/server.ts          — web interface
session/                 — credential registry, browser profile and web sessions (gitignored)
```

## License

MIT. Copyright (c) 2026 kravchenski.
