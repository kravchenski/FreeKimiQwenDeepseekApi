FROM oven/bun:1.3.14-slim AS base

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.14-slim AS runtime

ENV NODE_ENV=production \
    UNIFIED_PORT=3260 \
    HOST=0.0.0.0

WORKDIR /app

COPY --from=base /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
COPY deepseek.ts ./

RUN install -d -o bun -g bun /app/session /app/logs /app/data \
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} +

USER bun

EXPOSE 3260

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:3260/health');process.exit(r.ok?0:1)"]

CMD ["bun", "run", "src/unified/server.ts"]
