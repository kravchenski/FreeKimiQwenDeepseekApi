<div align="center">

# FreeQwenApi

**Free API proxy for Qwen, DeepSeek and NVIDIA models (Kimi, GLM, DeepSeek) — OpenAI-compatible endpoint for OpenCode, Continue, Cline, Aider and any AI agent.**

[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun&logoColor=000)](https://bun.sh)
[![OpenAI compatible](https://img.shields.io/badge/API-OpenAI%20compatible-412991)](#api-reference)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[Quick Start](#quick-start) · [Models](#models) · [API](#api-reference) · [Docker](#docker)

</div>

FreeQwenApi is a proxy for [Qwen](https://chat.qwen.ai), [DeepSeek Web](https://chat.deepseek.com/) and [NVIDIA API](https://build.nvidia.com) models (Kimi, GLM, DeepSeek) with an OpenAI-compatible API.

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
| **Qwen** | `qwen3.7-plus`, `qwen3.8-max`, `qwen3-coder-plus`, … (list fetched from the Qwen API proxy) | `bun run account add qwen --browser` or `QWEN_TOKEN` |
| **DeepSeek** | `deepseek-default`, `deepseek-reasoner`, `deepseek-expert`, `deepseek-search` | `bun run auth:deepseek` |
| **GLM / Kimi web chat** | `glm-chat` (chat.z.ai), `kimi-chat` (kimi.ai) — sent through your signed-in browser | `bun run account open <url>` |
| **NVIDIA** | every chat model your key can see (`deepseek-ai/*`, `moonshotai/*`, `z-ai/*`, `meta/*`, `mistralai/*`, …); models missing for your account are hidden after the first 404 | `NVIDIA_API_KEY` |

All models are free. NVIDIA is the fallback and requires an API key.

To see which models actually answer for your keys and accounts, run `bun run models:probe` while the gateway is running (`--provider all` includes web chats, `--help` for options). The gateway remembers every measurement in `data/gateway.db`, so a probe run also reorders `auto` with the fastest working models first.

```bash
curl http://localhost:3260/v1/models
```

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
| `GET` | `/health` | Server status |

DeepSeek supports tool calls. Web providers (DeepSeek) work through browser (Puppeteer) and support streaming. NVIDIA providers use `https://integrate.api.nvidia.com/v1`.

## Commands

| Command | Description |
|---------|-------------|
| `bun run start` | Start unified server (port 3260) |
| `bun run dev` | Start with watch mode |
| `bun run auth:deepseek` | Manage DeepSeek accounts |
| `bun run account` | Manage Qwen accounts (`add qwen --browser`, `list`, `remove`) |
| `bun run test` | Run tests |
| `bun run check` | Validate build |

## Docker

```bash
docker compose up -d
```

Starts the unified API on `127.0.0.1:3260` using `.env` for keys and mounting `session/`, `data/` and `logs/`. Add accounts on the host (`bun run account ...`) before starting. The old per-provider services are available with `docker compose --profile legacy up -d`.

## Images

OpenAI-compatible image endpoints backed by the Qwen API (uses the same Qwen token or accounts):

```bash
curl http://localhost:3260/v1/images/generations -H 'content-type: application/json' \
  -d '{"prompt":"a red fox in the snow","size":"16:9"}'
```

`POST /v1/images/edits` accepts one image as an https URL / data URL in JSON, or as a multipart `image` file.

## Monitoring

- `GET /v1/gateway/status` — providers, account states and recent requests (JSON)
- `GET /metrics` — Prometheus metrics: `gateway_requests_total`, `gateway_request_duration_seconds_sum`, `gateway_provider_available`, `gateway_accounts`
- Every response carries `x-request-id` (a safe incoming value is kept, otherwise one is generated)

Both endpoints require the bearer token when `GATEWAY_API_KEY` is set.

## Releases

Versions follow [Semantic Versioning](https://semver.org) and are derived from [Conventional Commits](https://www.conventionalcommits.org) by [release-please](https://github.com/googleapis/release-please): `feat` → minor, `fix` / `perf` / `refactor` → patch, `!` or `BREAKING CHANGE` → major. Every push to `main` updates a release PR; merging it creates the `vX.Y.Z` tag, a GitHub Release listing the commits in that version, updates `CHANGELOG.md`, publishes `ghcr.io/<owner>/freeqwenapi:X.Y.Z` and attaches desktop app binaries for Linux, macOS and Windows. Run the desktop binary from a clone of this repository (or set `FREEAPI_ROOT`).

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `UNIFIED_PORT` | `3260` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `NVIDIA_API_KEY` | - | NVIDIA API key (for DeepSeek V4 Pro, Kimi K2.6) |

## Project Structure

```
src/
  unified/server.ts      — main server (all providers)
  providers/             — provider clients (deepseek/, qwen/, OpenAI-compatible NVIDIA catalog)
  api/                   — API routes and chat logic
  browser/               — Puppeteer browser
  web/server.ts          — web interface
session/                 — account tokens (gitignored)
```

## License

MIT. Copyright (c) 2026 kravchenski.
