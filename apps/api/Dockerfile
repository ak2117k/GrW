# GrW API — single-stage image for free-tier PaaS deploys (Render, Railway, Fly).
#
# SINGLE-STAGE ON PURPOSE. A pnpm workspace links node_modules with symlinks and
# Prisma drops a native query-engine binary into node_modules/@prisma. Copying
# that layout across multi-stage boundaries reliably breaks the symlinks / engine
# path. One stage keeps install → generate → build → run all on the same tree,
# which is the safest bet for first-try correctness.
#
# BUILD CONTEXT IS THE REPO ROOT (not apps/api) so the whole workspace and the
# root-level prisma/ schema are visible. Build from the repo root with:
#   docker build -f apps/api/Dockerfile -t grw-api .
#
# BASE IMAGE FROM GOOGLE'S DOCKER HUB MIRROR. The official node image, same
# content, but GitHub's shared runners pull Docker Hub anonymously and hit its
# per-IP rate limit (429 Too Many Requests failed both builds on 2026-10-09).
# No `# syntax=` directive for the same reason: it pulls docker/dockerfile from
# Docker Hub, and this file needs nothing beyond the built-in frontend.
FROM mirror.gcr.io/library/node:22-bookworm-slim

# Prisma needs OpenSSL to pick the right native engine; ca-certificates for TLS
# to Neon (Postgres) and Upstash (Redis). Generating the client INSIDE this
# Linux image yields the correct linux engine (no custom binaryTargets needed).
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Pin pnpm via corepack to match packageManager in package.json.
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# Claude Code CLI for the sentinel's `cli` judge transport (SENTINEL_JUDGE=cli).
# Pinned: an unpinned CLI can change its JSON envelope or flags under a running
# system. Authenticates headlessly via CLAUDE_CODE_OAUTH_TOKEN (from
# `claude setup-token`); the transport strips ANTHROPIC_API_KEY so it can never
# silently bill the API instead.
ARG CLAUDE_CODE_VERSION=2.1.285
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
  && npm cache clean --force

WORKDIR /app

# Copy the entire workspace (see .dockerignore for what is excluded).
COPY . .

# Known-good build order (verified):
#   1. install all workspace deps from the frozen lockfile
#   2. build @td/shared (tsc) — @td/api imports its compiled dist
#   3. prisma generate from REPO ROOT (schema + migrations live at ./prisma)
#   4. build @td/api (nest build via SWC -> apps/api/dist)
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @td/shared build \
  && npx prisma generate --schema prisma/schema.prisma \
  && pnpm --filter @td/api build

ENV NODE_ENV=production

# Boot just starts the API. Migrations are applied OUT-OF-BAND (see the runbook),
# NOT on container boot: Render's network reaches Neon's POOLED endpoint (which
# the app uses at runtime via DATABASE_URL) but cannot complete a connection to
# Neon's DIRECT compute endpoint that Prisma Migrate requires — and migrate
# deploy hangs on the pooled PgBouncer endpoint (session advisory lock). So we
# run `prisma migrate deploy` from a machine that can reach the direct endpoint.
CMD ["node", "apps/api/dist/main.js"]
