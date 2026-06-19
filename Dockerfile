FROM oven/bun:1.3.14-slim AS base

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS builder

COPY . .
RUN bun build src/unified/server.ts --target=bun --outdir=dist --minify

FROM oven/bun:1.3.14-slim AS runtime

RUN DEBIAN_FRONTEND=noninteractive apt-get update \
 && apt-get install -y --no-install-recommends \
    chromium-headless-shell \
    ca-certificates \
    curl \
 && rm -f /usr/lib/chromium/libVkLayer_khronos_validation.so* /usr/lib/chromium/libVkICD_mock_icd.so* \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /usr/share/doc/* /usr/share/man/* /usr/share/info/*

ENV CHROME_PATH=/usr/bin/chromium-headless-shell \
    NODE_ENV=production \
    UNIFIED_PORT=3260 \
    HOST=0.0.0.0

WORKDIR /app

COPY --from=base /app/node_modules ./node_modules
COPY --from=builder /app/dist/server.js ./server.js
COPY --from=builder /app/package.json ./
COPY src/AvailableModels.txt ./src/AvailableModels.txt

RUN install -d -o bun -g bun /app/session /app/logs /app/uploads

USER bun

EXPOSE 3260

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:3260/health || exit 1

CMD ["bun", "run", "server.js"]
