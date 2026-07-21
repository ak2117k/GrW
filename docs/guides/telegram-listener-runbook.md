# Telegram Signal Listener — Runbook

Operational guide for the Phase-1 Telegram Signal Scorecard listener.

- **Spec:** `docs/superpowers/specs/2026-07-20-telegram-signal-scorecard-design.md`
- **Plan:** `docs/superpowers/plans/2026-07-20-telegram-signal-scorecard.md`
- **Scope:** admin-only, read-only measurement feature. No order placement anywhere.

## Overview

```
Telegram channels ──MTProto──▶ ai-engine listener ──POST /api/telegram/parse──▶ Claude parser
                                       │
                                       └──POST /webhooks/telegram/ingest (x-telegram-ingest-secret)──▶ NestJS telegram module
                                                                                                              │
                                                                                                    persist · resolve token · track outcome · scorecard
```

The listener (`ai-engine/src/services/telegram_listener.py`, entrypoint
`ai-engine/src/telegram_listener_main.py`) holds a persistent Telethon MTProto
connection using a pre-generated `StringSession`, parses each new message with
the Claude-backed parser route, and forwards the structured result to the NestJS
ingest endpoint over a shared secret. It also backfills messages missed while
down, driven by per-channel `last-seen` pointers served by NestJS.

---

## 1. One-time: generate the Telethon `StringSession`

Telethon needs a logged-in session. Generate a `StringSession` string **once**,
interactively, on a machine where you can receive the Telegram login code. This
is the only interactive step — the running listener never prompts.

Prerequisites:

- A Telegram account (the admin-curated account that is a member of the channels
  you want to watch).
- `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` from <https://my.telegram.org> →
  **API development tools** (create one app; any name/URL is fine).

Run this short login script (Telethon must be installed:
`py -m pip install telethon==1.36.0`):

```python
# scripts/gen_telegram_session.py  (throwaway; do NOT commit the output)
from telethon.sync import TelegramClient
from telethon.sessions import StringSession

api_id = int(input("API ID: "))
api_hash = input("API HASH: ").strip()

with TelegramClient(StringSession(), api_id, api_hash) as client:
    # Prompts for phone number, then the login code Telegram sends you
    # (and your 2FA password if enabled).
    print("\n=== TELEGRAM_SESSION (store encrypted; never commit / log) ===")
    print(client.session.save())
```

```bash
py scripts/gen_telegram_session.py
```

Copy the printed string. **Treat it like a password** — it grants full access to
the account. Do NOT commit it, log it, or paste it into chat.

### Storing it encrypted at rest

The platform encrypts secrets at rest with AES-256-GCM via `encryptField()`
(`apps/api/src/common/crypto/field-crypto.ts`), keyed off `ENCRYPTION_KEY`. Store
the ciphertext (e.g. in your secrets manager / an encrypted `.env` vault), and at
runtime provide the **decrypted** string to the listener process as the
`TELEGRAM_SESSION` environment variable. The listener reads the plaintext
`StringSession` directly (`telegram_listener.py` →
`StringSession(os.environ["TELEGRAM_SESSION"])`); it does not decrypt, so the
decrypt step is the deployment's responsibility (secrets manager injection, or an
`encryptField`/`decryptField` round-trip in your provisioning script). Never write
the plaintext to disk or logs.

---

## 2. Environment variables

### Listener side (ai-engine — `python -m src.telegram_listener_main`)

| Var | Required | Purpose |
|-----|----------|---------|
| `TELEGRAM_API_ID` | yes | Telegram app id from my.telegram.org |
| `TELEGRAM_API_HASH` | yes | Telegram app hash from my.telegram.org |
| `TELEGRAM_SESSION` | yes | Decrypted Telethon `StringSession` (see §1). Secret. |
| `TELEGRAM_WATCH_CHANNELS` | yes | Comma-separated numeric channel ids to watch (see §4) |
| `AI_ENGINE_URL` | no (default `http://localhost:5000`) | Base URL of the ai-engine itself; the listener calls `{AI_ENGINE_URL}/api/telegram/parse` |
| `TELEGRAM_INGEST_URL` | yes | NestJS ingest URL, e.g. `http://localhost:3001/webhooks/telegram/ingest` |
| `TELEGRAM_INGEST_SECRET` | yes | Shared secret sent as `x-telegram-ingest-secret`; must equal the NestJS value |

### NestJS side (apps/api)

| Var | Required | Default | Purpose |
|-----|----------|---------|---------|
| `TELEGRAM_INGEST_SECRET` | yes (required in production — boot fails without it) | — | Shared secret; constant-time compared on every ingest/last-seen request |
| `TELEGRAM_MIN_CONFIDENCE` | no | `0.55` | Min parser confidence for a message to be promoted to a tracked signal |
| `TELEGRAM_MIN_SAMPLE` | no | `5` | Leaderboard win-rate shows `null` below this many resolved (win+loss) signals |
| `TELEGRAM_SWING_TRACK_DAYS` | no | `10` | Days a SWING signal stays tracked before it goes `EXPIRED` |

Notes:

- `TELEGRAM_INGEST_SECRET` must be **identical** on both sides. On the NestJS side
  it is validated at boot in production (`validate-boot-config.ts`); the endpoint
  fails closed (rejects all requests) if it is unset.
- Secrets are never logged — only lengths appear in auth-failure warnings.

---

## 3. Parser LLM authentication (important)

The parser (`ai-engine/src/services/telegram_parser_service.py`) calls the LLM in
`_call_llm`, which uses the **Claude Agent SDK** (`claude-agent-sdk`). It
authenticates via the **host's Claude subscription login** — the same Claude Code
/ `claude` login you use locally — and does **NOT** use an `ANTHROPIC_API_KEY`.

Implications:

- **Local R&D (free path):** on a machine already logged into Claude Code on a
  Pro/Max plan, the parser runs at ₹0 — no API key, no per-token billing. This is
  the intended development setup.
- **Production / always-on:** a background worker has no interactive Claude login
  by default. Choose one of:
  1. Put a valid Claude Code login on the server (run `claude` login once so the
     Agent SDK can reuse the host credentials), **or**
  2. Swap the `_call_llm` body for a raw `anthropic` Messages-API backend keyed by
     `ANTHROPIC_API_KEY` (e.g. `claude-haiku-4-5`). `_call_llm` is the single
     swappable seam — `parse_signal`/`_normalize` and the golden-set tests are
     untouched by the swap.
- The golden-set tests monkeypatch `_call_llm`, so `py -m pytest tests/test_telegram_parser.py`
  runs fully offline with neither a login nor the SDK package installed.

---

## 4. Joining channels + collecting numeric ids

1. Using the **same account** whose session you generated, join each channel you
   want to score (public `@handle` or invite link).
2. Collect each channel's **numeric id** (a supergroup/channel id, typically a
   large negative number like `-1001234567890`). Options:
   - Forward a message from the channel to `@userinfobot` / `@JsonDumpBot`, or
   - Enumerate dialogs with Telethon:
     ```python
     from telethon.sync import TelegramClient
     from telethon.sessions import StringSession
     import os
     with TelegramClient(StringSession(os.environ["TELEGRAM_SESSION"]),
                         int(os.environ["TELEGRAM_API_ID"]),
                         os.environ["TELEGRAM_API_HASH"]) as c:
         for d in c.iter_dialogs():
             print(d.id, "|", d.name)
     ```
3. Put the ids, comma-separated, into `TELEGRAM_WATCH_CHANNELS`, e.g.:
   ```
   TELEGRAM_WATCH_CHANNELS=-1001234567890,-1009876543210
   ```
   The listener casts each id with `int(...)` and subscribes via
   `events.NewMessage(chats=...)`, so ids must be numeric (not `@handles`).

---

## 5. Running the listener

Prerequisites: the ai-engine (FastAPI) must be up (the listener calls its parse
route), and the NestJS api must be up (ingest target).

```bash
# 1. ai-engine deps (once)
cd ai-engine && py -m pip install -r requirements.txt

# 2. ai-engine API (serves /api/telegram/parse)
cd ai-engine && py -m src.main         # or the project's dev command

# 3. NestJS api (serves /webhooks/telegram/ingest) — separate terminal
npm run dev:api

# 4. the listener — separate terminal, with env vars set
cd ai-engine && py -m src.telegram_listener_main
```

On start the listener: connects the Telethon client, backfills each watched
channel from its NestJS `last-seen` pointer (`GET /webhooks/telegram/last-seen`),
then streams live messages. One bad message is logged and skipped — it does not
kill the stream. Restart-safe: on reconnect it resumes from the last-seen pointer.

> `py` is the Windows Python launcher (Python 3.14 on this machine). On
> Linux/macOS use `python3`. The `python` on this Windows box is a Store stub —
> use `py`.

### Free-now → promote-to-always-on

Per the spec (§2), this runs **free during R&D** (locally / free tier) but is
architected as a **dedicated always-on worker**. To promote it:

- Deploy `telegram_listener_main` as its own long-lived process (its own Render
  Background Worker / systemd unit / container), separate from the request-serving
  ai-engine.
- Resolve the parser-auth question (§3) — server-side Claude login **or** the
  `ANTHROPIC_API_KEY` backend swap.
- Point `TELEGRAM_INGEST_URL` / `AI_ENGINE_URL` at the deployed hosts and set a
  strong `TELEGRAM_INGEST_SECRET` on both sides.

No application code changes are required to move from local to always-on.

---

## 6. Database migration

The scorecard tables (`telegram_channels`, `telegram_messages`,
`telegram_signals`, `telegram_signal_events`) ship as a Prisma migration under
`prisma/migrations/`.

Apply it against the target database:

```bash
# DIRECT_URL must point at the DB (non-pooled connection for Neon/pgbouncer setups)
DIRECT_URL="postgres://…" npx prisma migrate deploy
```

> **Status caveat:** this migration was **generated offline and has NOT yet been
> applied to a live database.** Before the first production run, apply it against a
> real DB and confirm it succeeds — in particular that `telegram_signals.targets`
> is created as a `double precision[]` column. Take a backup / run against staging
> first per your normal migration process.

---

## Quick reference — test sweep

```bash
cd apps/api  && npx jest telegram --silent
cd ai-engine && py -m pytest tests/test_telegram_parser.py tests/test_telegram_listener.py -v
cd apps/web  && npx vitest run src/services/telegram.spec.ts
```
