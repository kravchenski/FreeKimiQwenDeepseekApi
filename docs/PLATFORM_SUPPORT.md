# Platform Support

FreeQwenApi uses Bun for the host runtime and supports:

| Platform | Native Qwen | Native DeepSeek | Docker Compose | CI |
| --- | --- | --- | --- | --- |
| Linux x64/arm64 | Supported | Supported | Supported | Tested |
| macOS arm64/x64 | Supported | Supported | Docker Desktop | Tested |
| Windows x64 | Supported | Supported | Docker Desktop / WSL2 | Tested |

## Portable Commands

Use the same commands in Bash, zsh, PowerShell, and Command Prompt:

```text
bun install
bun run start:full
bun run start:deepseek:full
bun run start:deepseek:full
bun run start:full -- --check-only
bun run setup:agents -- --dry-run
bun run setup:pi
```

## Browser Discovery

Qwen and DeepSeek authentication automatically search common installations of:

- Google Chrome
- Chromium
- Microsoft Edge
- Brave

Standard Linux, macOS, and Windows install paths are supported. Override
discovery when needed:

```text
CHROME_PATH=/path/to/browser
```

Provider-specific browser paths take priority only for their registration flow.
Headless-only Chromium is never selected for interactive login.

## Docker

Docker images are Linux containers. On macOS and Windows, run them through
Docker Desktop or another Linux-container runtime:

```text
docker compose up -d
docker compose ps
```

The published container image targets `linux/amd64` and `linux/arm64`.

## Path and Session Portability

Runtime paths use Node/Bun path APIs instead of hard-coded separators.
Authentication and remote-chat mappings remain under `session/`. Back up that
directory before moving an installation to another machine.
