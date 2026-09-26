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
| **DeepSeek** | `deepseek-default`, `deepseek-expert`, `deepseek-search` | Browser auth |
| **NVIDIA** | `deepseek-ai/deepseek-v4.1-flash`, `moonshotai/kimi-k3`, `z-ai/glm-5.3` (list fetched from NVIDIA) | `NVIDIA_API_KEY` |

All models are free. NVIDIA requires an API key.

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
