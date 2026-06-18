<div align="center">

# FreeQwenApi

**Turn DeepSeek Web, Qwen Chat, and ZenMux models into a local OpenAI-compatible API — подключи к OpenCode, Continue, Cline, Aider и любым AI-агентам.**

[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun&logoColor=000)](https://bun.sh)
[![OpenAI compatible](https://img.shields.io/badge/API-OpenAI%20compatible-412991)](#api-reference)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[Быстрый старт](#быстрый-старт) · [Модели](#модели) · [API](#api-reference) · [OpenCode](#opencode) · [Docker](#docker)

</div>

FreeQwenApi — прокси для [DeepSeek Web](https://chat.deepseek.com/), [Qwen Chat](https://chat.qwen.ai/), а также моделей [Kimi](https://kimi.ai), [GLM](https://z.ai), [Sapiens](https://sapiens.ai) и [StepFun](https://stepfun.com) через [ZenMux](https://zenmux.ai) с OpenAI-совместимым API. Для Web-провайдеров не нужны API-ключи; для ZenMux-провайдеров нужен `ZENMUX_API_KEY`.

## Быстрый старт

```bash
git clone https://github.com/kravchenski/FreeQwenApi.git
cd FreeQwenApi
bun install
bun run setup:all
```

Скрипт проверит наличие аккаунтов для всех провайдеров, при необходимости откроет браузер для входа, и запустит сервер.

**Сервер:** `http://localhost:3260`  
**OpenCode:** `OPENCODE_API_URL=http://localhost:3260`, `OPENCODE_API_KEY=` (пусто)

### Вручную

```bash
# Авторизация (разово)
bun run auth             # Qwen
bun run auth:all         # DeepSeek, ChatGPT, Qwen, Gemini (браузер)

# Запуск
bun run start
```

## Модели

| Провайдер | Модели |
|-----------|--------|
| **DeepSeek** | `deepseek-default`, `deepseek-reasoner`, `deepseek-expert`, `deepseek-search` |
| **Qwen** | `qwen3.6-plus`, `qwen3.7-max`, `qwen3.7-plus`, `qwq-32b` и др. |
| **Kimi** (ZenMux) | `kimi-k2.7-code-free`, `kimi-k2.6`, `kimi-k2.6-thinking`, `kimi-k2.6-search`, `kimi-k2.6-thinking-search` |
| **GLM** (ZenMux) | `glm-5.2-free`, `glm-4.7`, `glm-4.7-flashx`, `glm-4.7-flash-free`, `glm-4.6v-flash-free`, `glm-4.5` |
| **Sapiens** (ZenMux) | `sapiens-ai/agnes-2.0-flash` |
| **StepFun** (ZenMux) | `stepfun/step-3.7-flash-free` |
| **NVIDIA** | `deepseek-ai/deepseek-v4-pro`, `nvidia/nemotron-3-ultra-550b-a55b` |

```bash
curl http://localhost:3260/v1/models
```

## Первый запрос

```bash
curl http://localhost:3260/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen-max-latest",
    "messages": [{"role": "user", "content": "Привет!"}],
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
      "default": ["qwen-max-latest"],
      "all": ["deepseek-default", "deepseek-reasoner", "deepseek-expert", "deepseek-search", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "glm-5.2-free", "glm-4.7", "glm-4.7-flashx", "glm-4.7-flash-free", "glm-4.6v-flash-free", "glm-4.5", "kimi-k2.7-code-free", "kimi-k2.6", "kimi-k2.6-thinking", "kimi-k2.6-search", "kimi-k2.6-thinking-search", "sapiens-ai/agnes-2.0-flash", "stepfun/step-3.7-flash-free"]
    }
  }
}
```

## API Reference

Все эндпоинты OpenAI-совместимы:

| Метод | Эндпоинт | Описание |
|-------|----------|----------|
| `GET` | `/v1/models` | Список моделей |
| `POST` | `/v1/chat/completions` | Chat Completions (streaming + non-streaming) |
| `GET` | `/health` | Статус сервера |

DeepSeek и Qwen поддерживают tool calls.
Web-провайдеры (DeepSeek, Qwen) работают через браузер (Puppeteer) и поддерживают streaming.
ZenMux-провайдеры (Kimi, GLM, Sapiens, StepFun) используют OpenAI-совместимый API `https://zenmux.ai/api/v1`.

## Команды

| Команда | Описание |
|---------|----------|
| `bun run start` | Запуск unified сервера (все провайдеры, порт 3260) |
| `bun run setup:all` | Авторизация всех провайдеров + запуск |
| `bun run dev` | Запуск с watch-mode |
| `bun run auth` | Управление Qwen аккаунтами |
| `bun run auth:all` | Управление DeepSeek, ChatGPT, Qwen, Gemini аккаунтами |
| `bun run web` | Веб-интерфейс (порт 3000) |
| `bun run test` | Запуск тестов |
| `bun run check` | Проверка сборки |

## Docker

```bash
docker build -t freeqwenapi .
docker run -d \
  -p 3260:3260 \
  -v ./session:/app/session \
  freeqwenapi
```

Аккаунты должны быть настроены на хосте перед запуском:

```bash
bun install
bun run auth
bun run auth:all
```

## Переменные окружения

| Переменная | По умолчанию | Описание |
|-----------|-------------|----------|
| `UNIFIED_PORT` | `3260` | Порт unified сервера |
| `HOST` | `0.0.0.0` | Адрес для бинда |
| `DEFAULT_MODEL` | `qwen-max-latest` | Модель по умолчанию |
| `SKIP_ACCOUNT_MENU` | `false` | Пропустить меню аккаунтов |
| `CHROME_PATH` | авто | Путь к Chrome/Chromium |
| `UI_PORT` | `3000` | Порт веб-интерфейса (`bun run web`) |

Полный список в [`src/config.ts`](src/config.ts).

## Структура проекта

```
src/
  unified/server.ts    — основной сервер (DeepSeek + ChatGPT + Qwen + Gemini)
  providers/           — клиенты провайдеров (deepseek/, chatgpt/, qwen/, gemini/)
  api/                 — Qwen API (чат, модели, токены, файлы)
  browser/             — Puppeteer браузер
  web/server.ts        — веб-интерфейс (порт 3000)
  scripts/             — авторизация, setup, smoke-тесты
session/               — токены аккаунтов (в .gitignore)
```

## License

MIT. Copyright (c) 2026 kravchenski.
