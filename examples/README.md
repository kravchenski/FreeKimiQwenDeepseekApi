# FreeQwenApi examples

Ready-to-run examples for the OpenAI-compatible unified API in TypeScript, Python and LiteLLM.

## Setup

```bash
bun install
bun run start
```

All examples call `http://localhost:3260/v1` with the `auto` model. Override with environment variables:

- `FREEAPI_BASE_URL` — API base URL
- `FREEAPI_MODEL` — model id (see `GET /v1/models`)
- `GATEWAY_API_KEY` — bearer token, when the gateway is protected

## TypeScript

| Task | Command |
| --- | --- |
| Simple request with the OpenAI SDK | `bun run example:simple` |
| Streaming reply | `bun run example:stream` |
| System message | `bun run example:system` |
| Conversation with context | `bun run example:conversation` |
| Image analysis | `bun run example:image` |
| Models, chat and Responses API | `bun run example:compatibility` |
| Plain `fetch` request | `bun run example:direct` |
| `ofetch` with a conversation id | `bun run example:ofetch` |
| Streaming timing test | `bun run example:streaming-test` |

Sources live in [`openai-sdk/`](openai-sdk/) and [`direct-api/`](direct-api/).

## Python

### OpenAI SDK

```bash
pip install openai
cd examples/python-sdk
python simple.py
python streaming.py
```

### Plain HTTPX

```bash
pip install httpx
python examples/python-direct/httpx_example.py
python examples/python-direct/httpx_streaming.py
```

## Agents and bridges

- [`litellm/`](litellm/) — LiteLLM bridge config for Codex and Claude Code

Configure supported agents automatically:

```bash
bun run setup:agents -- --dry-run
bun run setup:agents
```

See the [main README](../README.md) and [`docs/AGENT_INTEGRATIONS.md`](../docs/AGENT_INTEGRATIONS.md).
