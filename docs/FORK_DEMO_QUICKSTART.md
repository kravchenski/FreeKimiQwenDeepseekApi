# Быстрый старт для демо FreeQwenApi

Этот fork подготовлен под практичный сценарий для видео и демонстраций:

- синхронизация актуального списка моделей Qwen Chat (`qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus`);
- локальный OpenAI-совместимый эндпоинт для SDK, Hermes Agent, Open WebUI и LiteLLM;
- быстрая smoke-проверка, чтобы перед записью не гадать, жив ли прокси.

## 1. Один раз авторизуйтесь

```bash
bun run start:full
```

Кроссплатформенный launcher работает одинаково на Linux, macOS и Windows,
устанавливает зависимости, запускает проверки и открывает авторизацию.
Не публикуйте `session/`, cookies и файлы с токенами.

## 2. Синхронизируйте актуальные модели Qwen Chat

```bash
bun run models:sync
```

Команда читает публичные prerendered-метаданные моделей с `https://chat.qwen.ai/`, объединяет их с `src/AvailableModels.txt` и записывает отчёт сюда:

```text
docs/QWEN_CHAT_MODELS.md
```

## 3. Запустите эндпоинт

```bash
SKIP_ACCOUNT_MENU=true bun start
```

Эндпоинт:

```text
http://localhost:3264/api
```

## 4. Запустите smoke-проверку

В другом терминале:

```bash
bun run smoke
```

Модель для проверки по умолчанию:

```text
qwen3.7-max
```

Можно заменить:

```bash
QWEN_PROXY_SMOKE_MODEL=qwen3.7-plus bun run smoke
```

## 5. Проверка через OpenAI SDK / curl

```bash
curl http://localhost:3264/api/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.7-max",
    "messages": [
      {"role": "user", "content": "Ответь одним предложением: что такое локальный endpoint?"}
    ],
    "stream": false
  }'
```

## 6. Установка для AI-агентов

Сначала можно безопасно посмотреть план изменений:

```bash
bun run setup:agents -- --dry-run
bun run setup:agents
```

Команда настраивает Pi Agent, OpenCode, Continue и Hermes, создаёт отдельные
профили для Aider и Cline, а также LiteLLM-мост для Codex и Claude Code.

## 7. Пример провайдера для Hermes Agent

```yaml
custom_providers:
  - name: freeai
    base_url: http://127.0.0.1:3263/api
    api_key: dummy-key
    models:
      qwen3-coder-plus:
        context_length: 131072
      deepseek-default:
        context_length: 131072
```

Запуск:

```bash
hermes chat --provider custom:freeai --model qwen3-coder-plus
```

## 8. Codex и Claude Code через мост LiteLLM

Codex ожидает OpenAI Responses API, Claude Code ожидает Anthropic Messages API,
а этот прокси отдаёт OpenAI Chat Completions. Используйте сгенерированный
LiteLLM-конфиг как мост:

```bash
uvx --from "litellm[proxy]" litellm --config ~/.freeqwenapi/litellm.yaml --host 127.0.0.1 --port 4000
```

Запустите Codex или Claude Code:

```bash
FREEAI_API_KEY=dummy-key codex -p freeai -m qwen3-coder-plus
claude --settings ~/.claude/freeai-settings.json --model qwen3-coder-plus
```

## Важное уточнение

Можно говорить так:

> Это не локальная модель, которая работает на вашей видеокарте. Это локальный OpenAI-совместимый прокси к Qwen Chat — удобно для экспериментов с AI-агентами и локальными инструментами.

Не обещайте production-стабильность: лимиты Qwen Chat, срок жизни токенов, состояние аккаунта и совместимость API могут меняться.
