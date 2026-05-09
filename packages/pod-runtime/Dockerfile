# Subscription pod image. One pod = one Claude Pro/Max subscription token.
#
# Includes:
#   - @anthropic-ai/claude-code CLI on PATH (used by both `claude setup-token`
#     during onboarding and the Claude Agent SDK subprocess at run time)
#   - This package's HTTP runtime (Express /health + /run)

FROM node:20-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates git && \
    rm -rf /var/lib/apt/lists/*

# Install the Claude Code CLI globally. SDK invocations and `setup-token` both rely on it.
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src/ ./src/
COPY bin/ ./bin/

# Workspace dir for user projects (mounted at runtime; created here so it exists).
RUN mkdir -p /workspaces

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:4000/health || exit 1

CMD ["node", "bin/pod.js"]
