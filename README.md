<div align="center">

# FreeQwenApi

**Free API proxy for DeepSeek, Kimi, GLM, Sapiens, StepFun and NVIDIA models — OpenAI-compatible endpoint for OpenCode, Continue, Cline, Aider and any AI agent.**

[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun&logoColor=000)](https://bun.sh)
[![OpenAI compatible](https://img.shields.io/badge/API-OpenAI%20compatible-412991)](#api-reference)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[Quick Start](#quick-start) · [Models](#models) · [API](#api-reference) · [OpenCode](#opencode) · [Docker](#docker)

</div>

FreeQwenApi is a proxy for [DeepSeek Web](https://chat.deepseek.com/), [Kimi](https://kimi.ai), [GLM](https://z.ai), [Sapiens](https://sapiens.ai), [StepFun](https://stepfun.com) via [ZenMux](https://zenmux.ai), and [NVIDIA API](https://build.nvidia.com) models with an OpenAI-compatible API. Web providers don't need API keys. ZenMux providers need `ZENMUX_API_KEY`. NVIDIA providers need `NVIDIA_API_KEY`.

## Quick Start

```bash
git clone https://github.com/kravchenski/FreeQwenApi.git
cd FreeQwenApi
bun install
bun run start
```

**Server:** `http://localhost:3260`
**OpenCode:** `OPENCODE_API_URL=http://localhost:3260`, `OPENCODE_API_KEY=` (empty)

## Models

| Provider | Models | Key |
|----------|--------|-----|
| **DeepSeek** | `deepseek-default`, `deepseek-expert`, `deepseek-search` | Browser auth |
| **Kimi** (ZenMux) | `kimi-k2.7-code-free` | `ZENMUX_API_KEY` |
| **GLM** (ZenMux) | `glm-5.2-free`, `glm-4.7-flash-free` | `ZENMUX_API_KEY` |
| **Sapiens** (ZenMux) | `sapiens-ai/agnes-2.0-flash` | `ZENMUX_API_KEY` |
| **StepFun** (ZenMux) | `stepfun/step-3.7-flash-free` | `ZENMUX_API_KEY` |
| **NVIDIA** | `deepseek-ai/deepseek-v4-pro`, `moonshotai/kimi-k2.6` | `NVIDIA_API_KEY` |

All models are free. ZenMux and NVIDIA require API keys.

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

## OpenCode

```json
{
  "provider": {
    "id": "freeqwen",
    "name": "FreeQwenApi",
    "apiKey": "",
    "baseURL": "http://localhost:3260/v1",
    "models": {
      "default": ["deepseek-default"],
      "all": ["deepseek-default", "deepseek-expert", "deepseek-search", "kimi-k2.7-code-free", "glm-5.2-free", "glm-4.7-flash-free", "sapiens-ai/agnes-2.0-flash", "stepfun/step-3.7-flash-free", "deepseek-ai/deepseek-v4-pro", "moonshotai/kimi-k2.6"]
    }
  }
}
```

## API Reference

All endpoints are OpenAI-compatible:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/v1/models` | List models |
| `POST` | `/v1/chat/completions` | Chat Completions (streaming + non-streaming) |
| `GET` | `/health` | Server status |

DeepSeek and Kimi support tool calls. Web providers (DeepSeek) work through browser (Puppeteer) and support streaming. ZenMux providers (Kimi, GLM, Sapiens, StepFun) use `https://zenmux.ai/api/v1`. NVIDIA providers use `https://integrate.api.nvidia.com/v1`.

## Commands

| Command | Description |
|---------|-------------|
| `bun run start` | Start unified server (all providers, port 3260) |
| `bun run dev` | Start with watch mode |
| `bun run auth` | Manage DeepSeek accounts |
| `bun run web` | Web interface (port 3000) |
| `bun run test` | Run tests |
| `bun run check` | Validate build |

## Docker

```bash
docker build -t freeqwenapi .
docker run -d \
  -p 3260:3260 \
  -v ./session:/app/session \
  -e ZENMUX_API_KEY=your_key \
  -e NVIDIA_API_KEY=your_key \
  freeqwenapi
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `UNIFIED_PORT` | `3260` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `ZENMUX_API_KEY` | - | ZenMux API key (for Kimi, GLM, Sapiens, StepFun) |
| `NVIDIA_API_KEY` | - | NVIDIA API key (for DeepSeek V4 Pro, Kimi K2.6) |
| `SKIP_ACCOUNT_MENU` | `false` | Skip account menu on startup |

## Project Structure

```
src/
  unified/server.ts      — main server (all providers)
  providers/             — provider clients (deepseek/, kimi/, glm/, sapiens/, stepfun/, nvidia/)
  api/                   — API routes and chat logic
  browser/               — Puppeteer browser
  web/server.ts          — web interface (port 3000)
session/                 — account tokens (gitignored)
```

## License

MIT. Copyright (c) 2026 kravchenski.
