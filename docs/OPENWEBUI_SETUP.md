# Open WebUI setup

## 1. Connect the API

1. Open Open WebUI and sign in as an administrator.
2. Go to **Settings** → **Connections**.
3. Add an OpenAI-compatible connection:
   - **Base URL**: `http://host.docker.internal:3260/v1` (Open WebUI in Docker) or `http://localhost:3260/v1` (local)
   - **API Key**: the value of `GATEWAY_API_KEY`, or any text if it is not set

## 2. Models

The model list comes from `GET /v1/models`. Useful choices:

- `auto` — first available model with automatic fallback
- `deepseek-default`, `deepseek-reasoner` — DeepSeek web
- `glm-chat`, `kimi-chat` — GLM and Kimi through your signed-in browser
- `meta/*`, `nvidia/*`, `deepseek-ai/*`, … — NVIDIA fallback (every chat model your key can use)

## 3. Docker

```yaml
services:
  open-webui:
    image: ghcr.io/open-webui/open-webui:main
    ports:
      - "3000:8080"
    environment:
      - OPENAI_API_BASE_URLS=http://host.docker.internal:3260/v1
      - OPENAI_API_KEYS=your-gateway-api-key
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

## 4. Check it works

- Chat: pick `auto`, send "Hello! Tell me about yourself", expect a reply.

## 5. Troubleshooting

- **Connection refused**: make sure the gateway is running and the port is 3260.
- **401 / API key required**: use the `GATEWAY_API_KEY` value as the API key.
- **Model not found**: refresh the model list in Open WebUI and check `GET http://localhost:3260/v1/models`.
