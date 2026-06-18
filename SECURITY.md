# Security Policy

## Sensitive Local Data

FreeQwenApi stores authenticated provider state locally. Never publish:

- `session/`
- browser profiles and cookies
- bearer tokens and `Authorization.txt`
- logs containing provider responses
- `.env` files

Account files and persistent remote-chat maps are written with mode `0600`.
The Docker Compose configuration binds public host ports to `127.0.0.1` and
drops Linux capabilities by default.

## Safe Deployment

- Keep the unified gateway on localhost unless a trusted reverse proxy protects it.
- Set `GATEWAY_API_KEY` when other local users or processes are not trusted.
- Never commit `session/`, logs, browser profiles, or a populated `.env`.
- Rotate provider tokens immediately if a session directory is exposed.
- Run `bun run audit` and `bun run ci` before releases.

If credentials are exposed, revoke or refresh them immediately.

## Reporting

Do not open a public issue for vulnerabilities that expose credentials,
sessions, account data, or authentication bypasses. Contact the repository
maintainer privately with:

- affected version or commit;
- reproduction steps;
- impact;
- suggested mitigation, if available.

## Supported Versions

Security fixes target the latest `main` branch and the latest published
container image. This project connects to unofficial web APIs, so upstream
provider changes may require rapid compatibility updates.
