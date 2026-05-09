# Server image for claude-code QE portal.
# Postgres-backed Node.js Express server, no native build deps.

FROM node:20-slim AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

FROM node:20-slim
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
COPY bin/ ./bin/

RUN groupadd --system portal && \
    useradd --system --gid portal --home /app portal && \
    chown -R portal:portal /app

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

USER portal
CMD ["node", "bin/server.js"]
