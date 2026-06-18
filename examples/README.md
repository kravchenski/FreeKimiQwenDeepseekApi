# Примеры FreeQwenApi

Здесь собраны готовые примеры для OpenAI-совместимого API FreeQwenApi:
TypeScript, Python и LiteLLM.

## Установка и запуск

```bash
bun install
docker compose up -d
```

По умолчанию TypeScript-примеры обращаются напрямую к Qwen по адресу
`http://127.0.0.1:3264/api`. Для работы через единый gateway используйте
`http://127.0.0.1:3263/api`.

## Быстрый выбор

| Задача | Команда |
| --- | --- |
| Простой запрос через OpenAI SDK | `bun run example:simple` |
| Потоковый ответ | `bun run example:stream` |
| Системное сообщение | `bun run example:system` |
| Диалог с контекстом | `bun run example:conversation` |
| Анализ изображения | `bun run example:image` |
| Проверка OpenAI-совместимости | `bun run example:compatibility` |
| Прямой запрос через `fetch` | `bun run example:direct` |
| Прямой запрос через Axios | `bun run example:axios` |
| Загрузка файла | `bun run example:file-upload` |

Исходники TypeScript находятся в [`openai-sdk/`](openai-sdk/),
[`direct-api/`](direct-api/) и [`file-upload/`](file-upload/).

## Python

### OpenAI SDK

```bash
pip install openai
python examples/python-sdk/simple.py
python examples/python-sdk/streaming.py
```

### Прямые запросы через HTTPX

```bash
pip install httpx
python examples/python-direct/httpx_example.py
python examples/python-direct/httpx_streaming.py
```

## Агенты и мосты

Готовые конфигурации находятся в:

- [`litellm/`](litellm/) — мост для Codex и Claude Code.

Автоматическая настройка поддерживаемых агентов:

```bash
bun run setup:agents -- --dry-run
bun run setup:agents
```

Полная документация находится в [главном README](../README.md) и
[`docs/AGENT_INTEGRATIONS.md`](../docs/AGENT_INTEGRATIONS.md).
