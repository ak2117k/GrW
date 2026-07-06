# syntax=docker/dockerfile:1
#
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
FROM node:22-bookworm-slim

# Prisma needs OpenSSL to pick the right native engine; ca-certificates for TLS
# to Neon (Postgres) and Upstash (Redis). Generating the client INSIDE this
# Linux image yields the correct linux engine (no custom binaryTargets needed).
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Pin pnpm via corepack to match packageManager in package.json.
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

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

# On boot: apply any pending migrations against DATABASE_URL, then start the API.
# `migrate deploy` is idempotent — safe to run on every container start.
CMD ["sh", "-c", "npx prisma migrate deploy --schema prisma/schema.prisma && node apps/api/dist/main.js"]
