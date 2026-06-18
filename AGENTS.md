# Repository Guidelines

## Project Structure & Module Organization
- **`src/`**: Core modules including `api`, `browser`, `gateway`, `providers`, and `middleware`.
- **Root `.ts` files**: Entry points for individual services (`index.ts`, `deepseek.ts`, `kimi.ts`, `gateway.ts`).
- **`src/unified/server.ts`**: Main OpenCode-compatible API server (port 3260).
- **`test/`**: Unit and integration tests using Bun's test runner.
- **`scripts/`**: Automation for auth, setup, and CI checks.

## Build, Test, and Development Commands
- `bun run start` / `bun run start:unified`: Launches the unified API server (OpenCode-compatible).
- `bun run start:full`: Launches all providers and the unified gateway locally.
- `bun run test`: Runs unit tests in `./test`.
- `bun run check`: Validates TypeScript builds for all entry points.
- `bun run dev`: Starts unified API with watch mode.

## OpenCode API
- **Endpoint**: `http://localhost:3260/v1` (no API key required)
- **Models**:
  - `deepseek-*` — DeepSeek Web (default, reasoner, expert, search)
  - `qwen-*` — Qwen Web (max-latest, plus, qwen3-max, coder-plus, omni-flash, turbo, qwq-32b и др.)
  - `kimi-*` — Kimi via ZenMux
  - `glm-*` — GLM via ZenMux (включая glm-4.6v-flash-free)
  - `sapiens/*` — Sapiens Agnes 2.0 Flash via ZenMux
  - `stepfun/*` — StepFun Step 3.7 Flash Free via ZenMux
- **Configure OpenCode**:
  ```bash
  OPENCODE_API_URL=http://localhost:3260
  OPENCODE_API_KEY=
  ```
- Supports OpenAI-compatible streaming `/v1/chat/completions` and model listing `/v1/models`.

## Coding Style & Naming Conventions
- **Runtime**: Bun-first; avoid Node-specific APIs when Bun equivalents exist.
- **Language**: TypeScript with strict mode enabled.
- **Style**: 2-space indentation, ES modules (`import/export`), camelCase for variables/functions, PascalCase for types/classes.
- **Linting**: Use `knip` for unused dependency/code analysis (`bun run analyze`).

## Testing Guidelines
- **Framework**: Bun built-in test runner (`bun:test`).
- **Naming**: Files must match `*.test.ts` pattern.
- **Scope**: Prefer unit tests for providers/gateway logic; use mocks for external web APIs.
- **Coverage**: Ensure new provider adapters include at least one positive and one negative test case.

## Commit & Pull Request Guidelines
- **Commits**: Follow Conventional Commits format: `type(scope): description`.
  - Examples: `feat(gateway): add streaming support`, `fix(deepseek): handle PoW timeout`.
- **PRs**: Include summary of changes, linked issue numbers, and manual testing notes.
- **CI**: All PRs must pass `bun run check && bun run test` before merge.

## Security & Configuration Tips
- Never commit session data from `session/` directory.
- Use `.env.example` as template; never hardcode credentials.
- Validate all config via schema at startup to prevent runtime failures.
