# Telegram Signal Scorecard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest signals from admin-curated Telegram channels, parse them into structured signals with an LLM, auto-evaluate each one's outcome against market data, and surface a per-channel win-rate scorecard — read-only, admin-only.

**Architecture:** A Telethon listener in the Python `ai-engine` holds a persistent MTProto connection, parses each message via a new Anthropic-backed parser route, and POSTs the structured signal to a new NestJS `telegram` module over a shared-secret internal endpoint. NestJS persists, resolves the trading token, tracks the outcome (a `@Cron` poller for live signals + window-safe `getCandles` for backfilled ones), aggregates per-channel stats, and serves an admin React section. The module never imports `trade-engine` — order placement is structurally impossible.

**Tech Stack:** NestJS + Prisma (PostgreSQL), Bull/Redis, `@nestjs/schedule` cron, socket.io; Python 3.11 + FastAPI + Telethon + `anthropic`; React 18 + Vite + TS + Zustand + axios + socket.io-client.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-20-telegram-signal-scorecard-design.md`. This plan implements Phase 1 only.
- Read-only: the `telegram` module MUST NOT import anything from `trade-engine`. No order placement.
- Admin-only: HTTP surface gated with class-level `@AdminOnly()` (from `../../../common/decorators`); admin role value is the string `'ADMIN'`.
- Secrets never logged; only lengths. Constant-time compare (`timingSafeEqual`) for all shared secrets. Fail closed when a secret env var is unset.
- Telethon `StringSession` encrypted at rest via `encryptField()` (AES-256-GCM, keyed off `ENCRYPTION_KEY`). Never log it.
- Prisma conventions: `cuid()` ids, `@@map` snake_case table names, string enums, loose (non-`@relation`) cross-module refs where a lifecycle must not cascade.
- Naming: files kebab-case, classes PascalCase, DB tables snake_case, API routes kebab-case.
- Instrument type is parsed per message, never inferred from channel name.
- Win rate = `TARGET_HIT / (TARGET_HIT + SL_HIT)`; `EXPIRED`/`UNTRACKABLE` excluded from the ratio but shown as counts. SL-first tie-break on ambiguous candles. Min-sample guard on the leaderboard.
- Every task ends green (`npm test` for the touched workspace, or `pytest` for ai-engine) and a commit.
- Commit on branch `feature/telegram-signal-scorecard` (already created).

---

## File Structure

**Prisma**
- Modify: `prisma/schema.prisma` — add `TelegramChannel`, `TelegramMessage`, `TelegramSignal`, `TelegramSignalEvent`, enum `TelegramSignalStatus`.
- Create (generated): `prisma/migrations/<ts>_telegram_scorecard/migration.sql`.

**ai-engine (Python)**
- Create: `ai-engine/src/routes/telegram_parse.py` — FastAPI route `POST /api/telegram/parse`.
- Create: `ai-engine/src/services/telegram_parser_service.py` — Anthropic-backed text→signal.
- Create: `ai-engine/src/services/telegram_listener.py` — Telethon listener runnable.
- Create: `ai-engine/src/telegram_listener_main.py` — entrypoint (`python -m src.telegram_listener_main`).
- Modify: `ai-engine/src/main.py` — register the parse router.
- Modify: `ai-engine/requirements.txt` — add `telethon`, `anthropic`.
- Create: `ai-engine/tests/test_telegram_parser.py` — golden-set.

**NestJS (`apps/api/src/modules/telegram/`)**
- Create: `telegram.module.ts`
- Create: `dto/telegram-ingest.dto.ts`
- Create: `repositories/telegram.repository.ts`
- Create: `services/telegram-ingest.service.ts`
- Create: `services/outcome-eval.ts` (pure functions)
- Create: `services/telegram-tracker.service.ts`
- Create: `services/telegram-stats.service.ts`
- Create: `workers/telegram-track.processor.ts`
- Create: `controllers/telegram-ingest.controller.ts`
- Create: `controllers/telegram.controller.ts`
- Create: `gateways/telegram.gateway.ts`
- Modify: `apps/api/src/app.module.ts` — import `TelegramModule`.
- Modify: `apps/api/src/config/configuration.ts` — add `telegram` config block.
- Modify: `apps/api/src/common/config/validate-boot-config.ts` — require `TELEGRAM_INGEST_SECRET` in production.
- Modify: `.env.example` — new vars.
- Create (tests): `apps/api/test/telegram/*.spec.ts` + co-located `*.spec.ts`.

**Prerequisite (independent)**
- Create: `apps/api/src/modules/market-data/services/instrument-master-refresh.cron.ts`.

**Web (`apps/web/src/`)**
- Create: `services/telegram.ts`
- Create: `hooks/useTelegramScorecard.ts`
- Create: `pages/telegram/TelegramSignalsPage.tsx` (+ `ChannelsTab.tsx`, `SignalsFeedTab.tsx`, `LeaderboardTab.tsx`)
- Modify: `types/index.ts` — Telegram UI types.
- Modify: `App.tsx` — route.
- Modify: `components/layout/navItems.ts` — nav entry.
- Modify: `services/websocket.ts` — `/ws/telegram` namespace.

---

## Task 1: Prisma schema + migration

**Files:**
- Modify: `prisma/schema.prisma` (append near the Chartink models, ~line 572)
- Create: migration via CLI

**Interfaces:**
- Produces: Prisma models `TelegramChannel`, `TelegramMessage`, `TelegramSignal`, `TelegramSignalEvent`; enum `TelegramSignalStatus` with values `PENDING | ACTIVE | TARGET_HIT | SL_HIT | EXPIRED | UNTRACKABLE | INVALIDATED`. Client accessors: `prisma.telegramChannel`, `prisma.telegramMessage`, `prisma.telegramSignal`, `prisma.telegramSignalEvent`.

- [ ] **Step 1: Add the models to `prisma/schema.prisma`**

```prisma
model TelegramChannel {
  id            String            @id @default(cuid())
  tgChannelId   String            @unique
  username      String?
  title         String
  inviteLink    String?
  isActive      Boolean           @default(true)
  lastSeenMsgId Int               @default(0)
  joinedAt      DateTime?
  addedAt       DateTime          @default(now())
  messages      TelegramMessage[]
  signals       TelegramSignal[]
  @@map("telegram_channels")
}

model TelegramMessage {
  id          String           @id @default(cuid())
  channelId   String
  channel     TelegramChannel  @relation(fields: [channelId], references: [id])
  tgMessageId Int
  rawText     String
  postedAt    DateTime
  receivedAt  DateTime         @default(now())
  parseStatus String
  rawPayload  Json
  signal      TelegramSignal?
  @@unique([channelId, tgMessageId])
  @@index([channelId, postedAt])
  @@map("telegram_messages")
}

model TelegramSignal {
  id              String                @id @default(cuid())
  messageId       String                @unique
  message         TelegramMessage       @relation(fields: [messageId], references: [id])
  channelId       String
  channel         TelegramChannel       @relation(fields: [channelId], references: [id])
  symbol          String
  token           String?
  exchange        String?
  instrument      String
  side            String
  optionType      String?
  strike          Float?
  expiry          DateTime?
  signalType      String
  entryMode       String
  entryLow        Float?
  entryHigh       Float?
  slMode          String
  stopLoss        Float?
  targets         Float[]
  horizon         String
  parseConfidence Float
  status          TelegramSignalStatus  @default(PENDING)
  entryPrice      Float?
  entryFilledAt   DateTime?
  exitPrice       Float?
  exitAt          DateTime?
  hitTargetIndex  Int?
  resultPct       Float?
  trackExpiresAt  DateTime?
  createdAt       DateTime              @default(now())
  events          TelegramSignalEvent[]
  @@index([channelId, status])
  @@index([token, status])
  @@map("telegram_signals")
}

model TelegramSignalEvent {
  id       String          @id @default(cuid())
  signalId String
  signal   TelegramSignal  @relation(fields: [signalId], references: [id])
  type     String
  price    Float?
  note     String?
  at       DateTime        @default(now())
  @@index([signalId])
  @@map("telegram_signal_events")
}

enum TelegramSignalStatus {
  PENDING
  ACTIVE
  TARGET_HIT
  SL_HIT
  EXPIRED
  UNTRACKABLE
  INVALIDATED
}
```

- [ ] **Step 2: Generate the migration**

Run: `npx prisma migrate dev --name telegram_scorecard`
Expected: creates `prisma/migrations/<ts>_telegram_scorecard/migration.sql`, applies to dev DB, regenerates client. `telegram_signals.targets` is a `double precision[]` column.

- [ ] **Step 3: Verify the client compiles**

Run: `npx tsc -p apps/api/tsconfig.json --noEmit`
Expected: no errors referencing `telegramSignal`.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(telegram): add scorecard data model (channels, messages, signals, events)"
```

---

## Task 2: LLM parser route (ai-engine)

**Files:**
- Create: `ai-engine/src/services/telegram_parser_service.py`
- Create: `ai-engine/src/routes/telegram_parse.py`
- Modify: `ai-engine/src/main.py` (register router)
- Modify: `ai-engine/requirements.txt` (add `anthropic`)
- Test: `ai-engine/tests/test_telegram_parser.py`

**Interfaces:**
- Produces: `POST /api/telegram/parse` accepting `{ "text": str }`, returning the JSON contract below. Service fn `async def parse_signal(text: str) -> dict`.
- Contract (consumed by Task 3 listener and Task 5 ingest):
```json
{
  "isSignal": true, "symbol": "CRUDEOIL", "instrument": "OPTION",
  "exchange": "MCX", "side": "LONG", "optionType": "CE", "strike": 9500,
  "expiry": null, "signalType": "LEVELED", "entryMode": "NEAR",
  "entryLow": 225, "entryHigh": 225, "slMode": "PREMIUM_PAID",
  "stopLoss": null, "targets": [240, 260, 300], "horizon": "INTRADAY",
  "confidence": 0.9
}
```
Field domains: `instrument ∈ {EQUITY,OPTION,FUTURE,INDEX}`, `side ∈ {LONG,SHORT}`, `signalType ∈ {LEVELED,DIRECTIONAL}`, `entryMode ∈ {CMP,ZONE,TRIGGER_ABOVE,TRIGGER_BELOW,NEAR}`, `slMode ∈ {NUMERIC,PREMIUM_PAID,NONE}`, `horizon ∈ {INTRADAY,SWING}`, `confidence ∈ [0,1]`.

> **NOTE — LLM backend is the Claude Agent SDK (subscription auth), not the raw Messages API.** The ai-engine has no LLM client today. This task adds the **`claude-agent-sdk`** Python package and calls it from `_call_llm`. It authenticates via the user's **Claude Pro/Max subscription login** (`claude` / Claude Code login on the host) — **no `ANTHROPIC_API_KEY`**. This lets local R&D run on the existing Max plan at ₹0. Keep `_call_llm` as the single swappable seam so a raw-API-key backend (`anthropic` SDK + `claude-haiku-4-5`) can be dropped in for always-on production later without touching `parse_signal`/`_normalize`.
>
> **The implementer MUST verify the exact current `claude-agent-sdk` Python API before writing the call** — dispatch the `claude-code-guide` agent or WebFetch `https://code.claude.com/docs/en/agent-sdk` for the precise `query()` / `ClaudeAgentOptions` signatures and how to read assistant text from the returned messages. Do NOT guess the API. The prompt must instruct the model to return ONLY the JSON object (the schema in the Interfaces block); `_call_llm` extracts the assistant text, `json.loads` it, and returns the dict. The golden-set tests monkeypatch `_call_llm`, so they pass without any login — the real call is verified separately by the user on their logged-in machine.

- [ ] **Step 1: Add the dependency**

Edit `ai-engine/requirements.txt`, append:
```
claude-agent-sdk
```
Run: `pip install -r ai-engine/requirements.txt`
(Pin the version the implementer confirms is current from the Agent SDK docs.)

- [ ] **Step 2: Write failing golden-set tests**

Create `ai-engine/tests/test_telegram_parser.py`. Mock the Anthropic call so tests are deterministic and offline — patch the service's internal `_call_llm` to return canned JSON, and assert the service normalizes/validates correctly.

```python
import pytest
from src.services import telegram_parser_service as svc

@pytest.mark.asyncio
async def test_leveled_multi_target_crudeoil(monkeypatch):
    async def fake_llm(_text):
        return {
            "isSignal": True, "symbol": "CRUDEOIL", "instrument": "OPTION",
            "exchange": "MCX", "side": "LONG", "optionType": "CE", "strike": 9500,
            "expiry": None, "signalType": "LEVELED", "entryMode": "NEAR",
            "entryLow": 225, "entryHigh": 225, "slMode": "PREMIUM_PAID",
            "stopLoss": None, "targets": [240, 260, 300], "horizon": "INTRADAY",
            "confidence": 0.9,
        }
    monkeypatch.setattr(svc, "_call_llm", fake_llm)
    out = await svc.parse_signal("BUY CRUDEOIL 9500 CE / NEAR 225 / TARGET 240/260/300 / STOPLOSS PAID")
    assert out["signalType"] == "LEVELED"
    assert out["slMode"] == "PREMIUM_PAID"
    assert out["targets"] == [240, 260, 300]

@pytest.mark.asyncio
async def test_directional_no_levels(monkeypatch):
    async def fake_llm(_text):
        return {
            "isSignal": True, "symbol": "SGMART", "instrument": "EQUITY",
            "exchange": "NSE", "side": "LONG", "optionType": None, "strike": None,
            "expiry": None, "signalType": "DIRECTIONAL", "entryMode": "CMP",
            "entryLow": None, "entryHigh": None, "slMode": "NONE", "stopLoss": None,
            "targets": [], "horizon": "SWING", "confidence": 0.7,
        }
    monkeypatch.setattr(svc, "_call_llm", fake_llm)
    out = await svc.parse_signal("Sgmart — a perfect breakout continuation pattern")
    assert out["signalType"] == "DIRECTIONAL"
    assert out["targets"] == []

@pytest.mark.asyncio
async def test_rejects_out_of_domain_values(monkeypatch):
    async def fake_llm(_text):
        return {"isSignal": True, "symbol": "X", "instrument": "CRYPTO",  # invalid
                "side": "LONG", "signalType": "LEVELED", "entryMode": "CMP",
                "slMode": "NONE", "targets": [], "horizon": "INTRADAY", "confidence": 0.5}
    monkeypatch.setattr(svc, "_call_llm", fake_llm)
    out = await svc.parse_signal("whatever")
    assert out["isSignal"] is False  # invalid instrument → coerced to not-a-signal
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd ai-engine && python -m pytest tests/test_telegram_parser.py -v`
Expected: FAIL — `telegram_parser_service` has no `parse_signal`/`_call_llm`.

- [ ] **Step 4: Implement the service**

Create `ai-engine/src/services/telegram_parser_service.py`:

```python
"""Parse free-text Telegram trade signals into a structured contract via Claude."""
import json
import os
from typing import Any, Dict

_INSTRUMENT = {"EQUITY", "OPTION", "FUTURE", "INDEX"}
_SIDE = {"LONG", "SHORT"}
_SIGNAL_TYPE = {"LEVELED", "DIRECTIONAL"}
_ENTRY_MODE = {"CMP", "ZONE", "TRIGGER_ABOVE", "TRIGGER_BELOW", "NEAR"}
_SL_MODE = {"NUMERIC", "PREMIUM_PAID", "NONE"}
_HORIZON = {"INTRADAY", "SWING"}

_SYSTEM = (
    "You extract Indian-market trade signals from Telegram messages. "
    "Return ONLY the structured object. If the message is chatter, an ad, a "
    "P&L screenshot caption, or has no tradeable instrument, set isSignal=false. "
    "Instrument type comes from the message, never assumed. slMode='PREMIUM_PAID' "
    "when the stop is stated as 'PAID'/'premium'; 'NONE' when no stop; else 'NUMERIC'."
)

_NOT_A_SIGNAL = {
    "isSignal": False, "symbol": "", "instrument": "EQUITY", "exchange": None,
    "side": "LONG", "optionType": None, "strike": None, "expiry": None,
    "signalType": "DIRECTIONAL", "entryMode": "CMP", "entryLow": None,
    "entryHigh": None, "slMode": "NONE", "stopLoss": None, "targets": [],
    "horizon": "INTRADAY", "confidence": 0.0,
}


_SCHEMA_HINT = (
    'Return ONLY a JSON object, no prose, with these keys: '
    'isSignal(bool), symbol(str), instrument(one of EQUITY|OPTION|FUTURE|INDEX), '
    'exchange(str|null), side(LONG|SHORT), optionType(CE|PE|null), strike(number|null), '
    'expiry(str|null), signalType(LEVELED|DIRECTIONAL), '
    'entryMode(CMP|ZONE|TRIGGER_ABOVE|TRIGGER_BELOW|NEAR), entryLow(number|null), '
    'entryHigh(number|null), slMode(NUMERIC|PREMIUM_PAID|NONE), stopLoss(number|null), '
    'targets(array of numbers), horizon(INTRADAY|SWING), confidence(0..1 number).'
)


async def _call_llm(text: str) -> Dict[str, Any]:
    """Extract a structured signal via the Claude Agent SDK. Patched in tests.

    Auth: the Claude Agent SDK uses the host's Claude subscription login (Claude
    Code / `claude` login) — NO ANTHROPIC_API_KEY. Runs on the user's Max plan
    in local R&D. Production can swap this body for a raw `anthropic` Messages API
    call keyed by ANTHROPIC_API_KEY without touching parse_signal/_normalize.

    IMPLEMENTER: verify the exact claude-agent-sdk API (query()/ClaudeAgentOptions
    signatures, how to read assistant text) from https://code.claude.com/docs/en/agent-sdk
    or via the claude-code-guide agent BEFORE writing this. The shape below is
    indicative, not verified — confirm names against the docs.
    """
    from claude_agent_sdk import query, ClaudeAgentOptions  # lazy: tests don't import
    options = ClaudeAgentOptions(system_prompt=f"{_SYSTEM}\n\n{_SCHEMA_HINT}", max_turns=1)
    chunks: list[str] = []
    async for message in query(prompt=text, options=options):
        for block in getattr(message, "content", []) or []:
            piece = getattr(block, "text", None)
            if piece:
                chunks.append(piece)
    raw = "".join(chunks).strip()
    # Strip ```json fences if present, then parse.
    if raw.startswith("```"):
        raw = raw.split("```", 2)[1].removeprefix("json").strip()
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return dict(_NOT_A_SIGNAL)


def _normalize(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Validate/clamp the LLM output; coerce anything out-of-domain to not-a-signal."""
    if not raw.get("isSignal"):
        return dict(_NOT_A_SIGNAL)
    if (raw.get("instrument") not in _INSTRUMENT or raw.get("side") not in _SIDE
            or raw.get("signalType") not in _SIGNAL_TYPE
            or raw.get("entryMode") not in _ENTRY_MODE
            or raw.get("slMode") not in _SL_MODE or raw.get("horizon") not in _HORIZON):
        return dict(_NOT_A_SIGNAL)
    out = {**_NOT_A_SIGNAL, **raw}
    out["targets"] = [float(t) for t in (raw.get("targets") or []) if isinstance(t, (int, float))]
    out["confidence"] = max(0.0, min(1.0, float(raw.get("confidence", 0.0))))
    out["isSignal"] = True
    return out


async def parse_signal(text: str) -> Dict[str, Any]:
    if not text or not text.strip():
        return dict(_NOT_A_SIGNAL)
    raw = await _call_llm(text)
    return _normalize(raw)
```

- [ ] **Step 5: Add the route**

Create `ai-engine/src/routes/telegram_parse.py`:

```python
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from ..services.telegram_parser_service import parse_signal

router = APIRouter()


class ParseRequest(BaseModel):
    text: str = Field(..., min_length=1)


@router.post("/telegram/parse")
async def telegram_parse_endpoint(req: ParseRequest):
    try:
        return await parse_signal(req.text)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))
```

Register in `ai-engine/src/main.py` following the existing try/except + `include_router` pattern (near line 54 / 84):

```python
try:
    from .routes.telegram_parse import router as telegram_parse_router
except ImportError as e:
    telegram_parse_router = None
    _failed_modules.append(f"telegram_parse: {e}")
# ...
if telegram_parse_router is not None:
    app.include_router(telegram_parse_router, prefix="/api", tags=["telegram"])
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd ai-engine && python -m pytest tests/test_telegram_parser.py -v`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add ai-engine/src/services/telegram_parser_service.py ai-engine/src/routes/telegram_parse.py ai-engine/src/main.py ai-engine/requirements.txt ai-engine/tests/test_telegram_parser.py
git commit -m "feat(ai-engine): add Claude-backed Telegram signal parser route"
```

---

## Task 3: Telethon listener (ai-engine)

**Files:**
- Create: `ai-engine/src/services/telegram_listener.py`
- Create: `ai-engine/src/telegram_listener_main.py`
- Modify: `ai-engine/requirements.txt` (add `telethon`)
- Test: `ai-engine/tests/test_telegram_listener.py`

**Interfaces:**
- Consumes: parser `POST /api/telegram/parse` (Task 2); NestJS ingest `POST /webhooks/telegram/ingest` (Task 5) with header `x-telegram-ingest-secret`.
- Produces: `class TelegramListener` with `async def handle_message(self, channel: dict, message: dict) -> None` (parse → forward). Pure-ish `build_ingest_payload(channel, message, parsed) -> dict` for unit testing.
- Env: `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION`, `TELEGRAM_WATCH_CHANNELS` (comma ids), `AI_ENGINE_URL` (self, for parse), `TELEGRAM_INGEST_URL`, `TELEGRAM_INGEST_SECRET`.

- [ ] **Step 1: Add dependency**

Append to `ai-engine/requirements.txt`:
```
telethon==1.36.0
```
Run: `pip install -r ai-engine/requirements.txt`

- [ ] **Step 2: Write failing test for payload builder**

Create `ai-engine/tests/test_telegram_listener.py`:

```python
from src.services.telegram_listener import build_ingest_payload

def test_build_ingest_payload_maps_fields():
    channel = {"tgChannelId": "-100123", "username": "mrpinvest", "title": "Mr P"}
    message = {"tgMessageId": 42, "rawText": "BUY X", "postedAt": "2026-07-20T10:00:00Z"}
    parsed = {"isSignal": True, "symbol": "X", "confidence": 0.8}
    p = build_ingest_payload(channel, message, parsed)
    assert p["channel"]["tgChannelId"] == "-100123"
    assert p["message"]["tgMessageId"] == 42
    assert p["parsed"]["symbol"] == "X"
```

- [ ] **Step 3: Run to verify fail**

Run: `cd ai-engine && python -m pytest tests/test_telegram_listener.py -v`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement the listener**

Create `ai-engine/src/services/telegram_listener.py`:

```python
"""Persistent Telethon listener → parse → forward to NestJS ingest."""
import asyncio
import logging
import os
from typing import Any, Dict, List

import httpx

logger = logging.getLogger("telegram_listener")


def build_ingest_payload(channel: Dict[str, Any], message: Dict[str, Any],
                         parsed: Dict[str, Any]) -> Dict[str, Any]:
    return {"channel": channel, "message": message, "parsed": parsed}


class TelegramListener:
    def __init__(self) -> None:
        self.parse_url = f"{os.environ.get('AI_ENGINE_URL', 'http://localhost:5000')}/api/telegram/parse"
        self.ingest_url = os.environ["TELEGRAM_INGEST_URL"]
        self.ingest_secret = os.environ["TELEGRAM_INGEST_SECRET"]
        self.watch = [c.strip() for c in os.environ.get("TELEGRAM_WATCH_CHANNELS", "").split(",") if c.strip()]
        self._http = httpx.AsyncClient(timeout=30)

    async def parse(self, text: str) -> Dict[str, Any]:
        r = await self._http.post(self.parse_url, json={"text": text})
        r.raise_for_status()
        return r.json()

    async def forward(self, payload: Dict[str, Any]) -> None:
        r = await self._http.post(
            self.ingest_url, json=payload,
            headers={"x-telegram-ingest-secret": self.ingest_secret},
        )
        r.raise_for_status()

    async def handle_message(self, channel: Dict[str, Any], message: Dict[str, Any]) -> None:
        try:
            parsed = await self.parse(message["rawText"])
        except Exception as exc:  # noqa: BLE001 — one bad message must not kill the stream
            logger.warning("parse failed for msg %s: %s", message.get("tgMessageId"), exc)
            parsed = {"isSignal": False, "parseError": str(exc)}
        await self.forward(build_ingest_payload(channel, message, parsed))

    async def run(self) -> None:
        from telethon import TelegramClient, events
        from telethon.sessions import StringSession
        client = TelegramClient(
            StringSession(os.environ["TELEGRAM_SESSION"]),
            int(os.environ["TELEGRAM_API_ID"]), os.environ["TELEGRAM_API_HASH"],
        )
        watched = [int(c) for c in self.watch]

        @client.on(events.NewMessage(chats=watched))
        async def _on_message(event):  # noqa: ANN001
            chat = await event.get_chat()
            await self.handle_message(
                {"tgChannelId": str(event.chat_id),
                 "username": getattr(chat, "username", None),
                 "title": getattr(chat, "title", str(event.chat_id))},
                {"tgMessageId": event.id, "rawText": event.message.message or "",
                 "postedAt": event.message.date.isoformat()},
            )

        await client.start()
        await self.backfill(client, watched)
        logger.info("Listening on %d channels", len(watched))
        await client.run_until_disconnected()

    async def backfill(self, client, watched: List[int]) -> None:
        """Replay messages missed while down. lastSeen pointers come from NestJS."""
        try:
            r = await self._http.get(
                self.ingest_url.replace("/ingest", "/last-seen"),
                headers={"x-telegram-ingest-secret": self.ingest_secret},
            )
            last_seen = r.json() if r.status_code == 200 else {}
        except Exception:  # noqa: BLE001
            last_seen = {}
        for ch in watched:
            min_id = int(last_seen.get(str(ch), 0))
            async for msg in client.iter_messages(ch, min_id=min_id, reverse=True):
                chat = await msg.get_chat()
                await self.handle_message(
                    {"tgChannelId": str(ch), "username": getattr(chat, "username", None),
                     "title": getattr(chat, "title", str(ch))},
                    {"tgMessageId": msg.id, "rawText": msg.message or "",
                     "postedAt": msg.date.isoformat()},
                )
```

Create `ai-engine/src/telegram_listener_main.py`:

```python
import asyncio
import logging
from src.services.telegram_listener import TelegramListener

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(TelegramListener().run())
```

- [ ] **Step 5: Run to verify pass**

Run: `cd ai-engine && python -m pytest tests/test_telegram_listener.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ai-engine/src/services/telegram_listener.py ai-engine/src/telegram_listener_main.py ai-engine/requirements.txt ai-engine/tests/test_telegram_listener.py
git commit -m "feat(ai-engine): add Telethon listener with parse-and-forward + backfill"
```

---

## Task 4: NestJS repository + DTOs

**Files:**
- Create: `apps/api/src/modules/telegram/dto/telegram-ingest.dto.ts`
- Create: `apps/api/src/modules/telegram/repositories/telegram.repository.ts`
- Test: `apps/api/src/modules/telegram/repositories/telegram.repository.spec.ts`

**Interfaces:**
- Produces (DTO): `TelegramIngestDto { channel: TelegramChannelDto; message: TelegramMessageDto; parsed: Record<string, unknown> }`.
- Produces (repo `TelegramRepository`):
  - `upsertChannel(input: { tgChannelId: string; username?: string | null; title: string }): Promise<{ id: string }>`
  - `insertMessage(input: { channelId: string; tgMessageId: number; rawText: string; postedAt: Date; parseStatus: string; rawPayload: Prisma.InputJsonValue }): Promise<{ id: string } | null>` — returns `null` if the `[channelId, tgMessageId]` pair already exists (dedup).
  - `insertSignal(input: CreateSignalInput): Promise<{ id: string }>`
  - `advanceLastSeen(channelId: string, tgMessageId: number): Promise<void>`
  - `lastSeenByChannel(): Promise<Record<string, number>>`
  - `findActiveSignals(): Promise<TelegramSignalRow[]>` (status `PENDING` or `ACTIVE`)
  - `transition(signalId: string, patch: Prisma.TelegramSignalUpdateInput): Promise<void>`
  - `addEvent(input: { signalId: string; type: string; price?: number; note?: string }): Promise<void>`
  - `statsByChannel(): Promise<ChannelStatRow[]>`, `listChannels()`, `listSignals(params)`

- [ ] **Step 1: Write the DTO**

Create `apps/api/src/modules/telegram/dto/telegram-ingest.dto.ts`:

```ts
import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';

export class TelegramChannelDto {
  @IsString() @IsNotEmpty() tgChannelId!: string;
  @IsOptional() @IsString() username?: string | null;
  @IsString() @IsNotEmpty() title!: string;
}

export class TelegramMessageDto {
  @IsInt() tgMessageId!: number;
  @IsString() rawText!: string;
  @IsString() @IsNotEmpty() postedAt!: string; // ISO
}

export class TelegramIngestDto {
  @ValidateNested() @Type(() => TelegramChannelDto) channel!: TelegramChannelDto;
  @ValidateNested() @Type(() => TelegramMessageDto) message!: TelegramMessageDto;
  @IsObject() parsed!: Record<string, unknown>;
}
```

- [ ] **Step 2: Write failing repo test (dedup returns null on duplicate)**

Create `apps/api/src/modules/telegram/repositories/telegram.repository.spec.ts`. Follow the existing repo-spec style (mock `PrismaService`). Test that `insertMessage` returns `null` when Prisma throws P2002 (unique violation):

```ts
import { TelegramRepository } from './telegram.repository';

function makePrisma() {
  return {
    telegramChannel: { upsert: jest.fn().mockResolvedValue({ id: 'ch1' }) },
    telegramMessage: { create: jest.fn() },
  } as any;
}

describe('TelegramRepository.insertMessage', () => {
  it('returns null when the (channelId, tgMessageId) pair already exists', async () => {
    const prisma = makePrisma();
    prisma.telegramMessage.create.mockRejectedValue({ code: 'P2002' });
    const repo = new TelegramRepository(prisma);
    const res = await repo.insertMessage({
      channelId: 'ch1', tgMessageId: 1, rawText: 'x', postedAt: new Date(),
      parseStatus: 'signal', rawPayload: {},
    });
    expect(res).toBeNull();
  });

  it('returns the created row id on success', async () => {
    const prisma = makePrisma();
    prisma.telegramMessage.create.mockResolvedValue({ id: 'm1' });
    const repo = new TelegramRepository(prisma);
    const res = await repo.insertMessage({
      channelId: 'ch1', tgMessageId: 2, rawText: 'x', postedAt: new Date(),
      parseStatus: 'signal', rawPayload: {},
    });
    expect(res).toEqual({ id: 'm1' });
  });
});
```

- [ ] **Step 3: Run to verify fail**

Run: `cd apps/api && npx jest telegram.repository --silent`
Expected: FAIL — no `TelegramRepository`.

- [ ] **Step 4: Implement the repository**

Create `apps/api/src/modules/telegram/repositories/telegram.repository.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';

export interface CreateSignalInput {
  messageId: string; channelId: string; symbol: string; token: string | null;
  exchange: string | null; instrument: string; side: string; optionType: string | null;
  strike: number | null; expiry: Date | null; signalType: string; entryMode: string;
  entryLow: number | null; entryHigh: number | null; slMode: string; stopLoss: number | null;
  targets: number[]; horizon: string; parseConfidence: number;
  status: 'PENDING' | 'ACTIVE' | 'UNTRACKABLE'; entryPrice: number | null;
  trackExpiresAt: Date | null;
}

@Injectable()
export class TelegramRepository {
  private readonly logger = new Logger(TelegramRepository.name);
  constructor(private readonly prisma: PrismaService) {}

  async upsertChannel(input: { tgChannelId: string; username?: string | null; title: string }) {
    return this.prisma.telegramChannel.upsert({
      where: { tgChannelId: input.tgChannelId },
      create: { tgChannelId: input.tgChannelId, username: input.username ?? null, title: input.title },
      update: { title: input.title, username: input.username ?? undefined },
      select: { id: true },
    });
  }

  async insertMessage(input: {
    channelId: string; tgMessageId: number; rawText: string; postedAt: Date;
    parseStatus: string; rawPayload: Prisma.InputJsonValue;
  }): Promise<{ id: string } | null> {
    try {
      return await this.prisma.telegramMessage.create({
        data: { ...input }, select: { id: true },
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return null; // duplicate — idempotent
      throw e;
    }
  }

  async insertSignal(input: CreateSignalInput): Promise<{ id: string }> {
    return this.prisma.telegramSignal.create({ data: { ...input }, select: { id: true } });
  }

  async advanceLastSeen(channelId: string, tgMessageId: number): Promise<void> {
    await this.prisma.telegramChannel.updateMany({
      where: { id: channelId, lastSeenMsgId: { lt: tgMessageId } },
      data: { lastSeenMsgId: tgMessageId },
    });
  }

  async lastSeenByChannel(): Promise<Record<string, number>> {
    const rows = await this.prisma.telegramChannel.findMany({
      select: { tgChannelId: true, lastSeenMsgId: true },
    });
    return Object.fromEntries(rows.map((r) => [r.tgChannelId, r.lastSeenMsgId]));
  }

  async findActiveSignals() {
    return this.prisma.telegramSignal.findMany({
      where: { status: { in: ['PENDING', 'ACTIVE'] } },
    });
  }

  async transition(signalId: string, patch: Prisma.TelegramSignalUpdateInput): Promise<void> {
    await this.prisma.telegramSignal.update({ where: { id: signalId }, data: patch });
  }

  async addEvent(input: { signalId: string; type: string; price?: number; note?: string }): Promise<void> {
    await this.prisma.telegramSignalEvent.create({
      data: { signalId: input.signalId, type: input.type, price: input.price ?? null, note: input.note ?? null },
    });
  }

  async statsByChannel() {
    return this.prisma.telegramSignal.groupBy({
      by: ['channelId', 'status'], _count: { _all: true }, _avg: { resultPct: true },
    });
  }

  async listChannels() {
    return this.prisma.telegramChannel.findMany({ orderBy: { addedAt: 'desc' } });
  }

  async listSignals(params: { channelId?: string; status?: string; limit: number }) {
    return this.prisma.telegramSignal.findMany({
      where: {
        channelId: params.channelId,
        status: params.status as Prisma.EnumTelegramSignalStatusFilter['equals'],
      },
      orderBy: { createdAt: 'desc' }, take: params.limit,
      include: { message: { select: { rawText: true, postedAt: true } } },
    });
  }
}
```

- [ ] **Step 5: Run to verify pass**

Run: `cd apps/api && npx jest telegram.repository --silent`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/telegram/dto apps/api/src/modules/telegram/repositories
git commit -m "feat(telegram): add ingest DTO and repository with idempotent message insert"
```

---

## Task 5: Ingest service + internal controller

**Files:**
- Create: `apps/api/src/modules/telegram/services/telegram-ingest.service.ts`
- Create: `apps/api/src/modules/telegram/controllers/telegram-ingest.controller.ts`
- Test: `apps/api/src/modules/telegram/services/telegram-ingest.service.spec.ts`, `.../controllers/telegram-ingest.controller.spec.ts`

**Interfaces:**
- Consumes: `TelegramRepository` (Task 4); `InstrumentService.search(query, exchange?, segment?)` and `OptionsChainService.getLiveOptionLtp(underlying, expiryIso, strike, optionType)` for token resolution (Task 6 also uses these); Bull queue `telegram-track`.
- Produces: `TelegramIngestService.ingest(dto: TelegramIngestDto): Promise<{ messageId: string | null; signalId: string | null }>`. Exported `interface TelegramTrackJobData { signalId: string }`. Controller `POST /webhooks/telegram/ingest` + `GET /webhooks/telegram/last-seen`.
- Entry/status derivation rule (define here, consumed by tracker): `DIRECTIONAL` or `entryMode==='CMP'` → status `ACTIVE`, `entryPrice` = post-time price (resolved lazily by tracker if unavailable now → keep `null`, tracker fills). Otherwise `PENDING`. Missing token OR (`signalType==='LEVELED'` AND no `stopLoss`/`targets` AND `slMode==='NUMERIC'`) → `UNTRACKABLE`. `trackExpiresAt` = postedAt + (INTRADAY: end of trading day IST; SWING: +N days, N from config `telegram.swingTrackDays`, default 10).

- [ ] **Step 1: Write failing ingest test (dedup + not-signal + enqueue)**

Create `apps/api/src/modules/telegram/services/telegram-ingest.service.spec.ts`:

```ts
import { TelegramIngestService } from './telegram-ingest.service';

function deps() {
  const repo = {
    upsertChannel: jest.fn().mockResolvedValue({ id: 'ch1' }),
    insertMessage: jest.fn().mockResolvedValue({ id: 'm1' }),
    insertSignal: jest.fn().mockResolvedValue({ id: 's1' }),
    advanceLastSeen: jest.fn().mockResolvedValue(undefined),
  } as any;
  const queue = { add: jest.fn().mockResolvedValue(undefined) } as any;
  const instruments = { search: jest.fn().mockResolvedValue([{ token: '111', exchange: 'NSE' }]) } as any;
  const options = { getLiveOptionLtp: jest.fn() } as any;
  const config = { get: jest.fn().mockReturnValue(10) } as any;
  return { repo, queue, instruments, options, config,
    svc: new TelegramIngestService(repo, queue, instruments, options, config) };
}

const base = {
  channel: { tgChannelId: '-100', title: 'Mr P' },
  message: { tgMessageId: 5, rawText: 'BUY X', postedAt: '2026-07-20T04:00:00.000Z' },
};

it('skips duplicates (insertMessage null → no signal, no enqueue)', async () => {
  const d = deps();
  d.repo.insertMessage.mockResolvedValue(null);
  const res = await d.svc.ingest({ ...base, parsed: { isSignal: true, symbol: 'X' } } as any);
  expect(res.messageId).toBeNull();
  expect(d.repo.insertSignal).not.toHaveBeenCalled();
  expect(d.queue.add).not.toHaveBeenCalled();
});

it('stores non-signals but creates no signal', async () => {
  const d = deps();
  const res = await d.svc.ingest({ ...base, parsed: { isSignal: false } } as any);
  expect(res.messageId).toBe('m1');
  expect(res.signalId).toBeNull();
  expect(d.repo.insertSignal).not.toHaveBeenCalled();
});

it('creates a tracked signal and enqueues when resolvable', async () => {
  const d = deps();
  const res = await d.svc.ingest({ ...base, parsed: {
    isSignal: true, symbol: 'X', instrument: 'EQUITY', side: 'LONG', signalType: 'LEVELED',
    entryMode: 'ZONE', entryLow: 100, entryHigh: 102, slMode: 'NUMERIC', stopLoss: 95,
    targets: [110], horizon: 'INTRADAY', confidence: 0.8,
  } } as any);
  expect(res.signalId).toBe('s1');
  expect(d.queue.add).toHaveBeenCalledWith('track', { signalId: 's1' });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd apps/api && npx jest telegram-ingest.service --silent`
Expected: FAIL.

- [ ] **Step 3: Implement the ingest service**

Create `apps/api/src/modules/telegram/services/telegram-ingest.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { TelegramRepository, CreateSignalInput } from '../repositories/telegram.repository';
import { InstrumentService } from '../../market-data/services/instrument.service';
import { OptionsChainService } from '../../options-chain/services/options-chain.service';
import { TelegramIngestDto } from '../dto/telegram-ingest.dto';

export interface TelegramTrackJobData { signalId: string; }

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

@Injectable()
export class TelegramIngestService {
  private readonly logger = new Logger(TelegramIngestService.name);
  constructor(
    private readonly repo: TelegramRepository,
    @InjectQueue('telegram-track') private readonly queue: Queue<TelegramTrackJobData>,
    private readonly instruments: InstrumentService,
    private readonly options: OptionsChainService,
    private readonly config: ConfigService,
  ) {}

  async ingest(dto: TelegramIngestDto): Promise<{ messageId: string | null; signalId: string | null }> {
    const channel = await this.repo.upsertChannel(dto.channel);
    const parsed = dto.parsed as Record<string, any>;
    const isSignal = parsed?.isSignal === true;
    const confident = (Number(parsed?.confidence) || 0) >= (this.config.get<number>('telegram.minConfidence') ?? 0.55);
    const parseStatus = !isSignal ? 'not-signal' : confident ? 'signal' : 'low-confidence';

    const msg = await this.repo.insertMessage({
      channelId: channel.id, tgMessageId: dto.message.tgMessageId,
      rawText: dto.message.rawText, postedAt: new Date(dto.message.postedAt),
      parseStatus, rawPayload: parsed as Prisma.InputJsonValue,
    });
    if (!msg) return { messageId: null, signalId: null }; // duplicate

    await this.repo.advanceLastSeen(channel.id, dto.message.tgMessageId);
    if (!isSignal || !confident) return { messageId: msg.id, signalId: null };

    const token = await this.resolveToken(parsed);
    const input = this.toSignalInput(msg.id, channel.id, parsed, token, new Date(dto.message.postedAt));
    const sig = await this.repo.insertSignal(input);
    if (input.status !== 'UNTRACKABLE') {
      await this.queue.add('track', { signalId: sig.id });
    } else {
      await this.repo.addEvent({ signalId: sig.id, type: 'UNTRACKABLE', note: 'token/levels unresolved' });
    }
    return { messageId: msg.id, signalId: sig.id };
  }

  private async resolveToken(p: Record<string, any>): Promise<{ token: string; exchange: string } | null> {
    if (p.instrument === 'OPTION') return null; // options tracked live via premium (Task 6); token resolved there
    const hits = await this.instruments.search(String(p.symbol), p.exchange ?? undefined);
    const exact = hits.find((h) => h.symbol?.toUpperCase() === String(p.symbol).toUpperCase()) ?? hits[0];
    return exact ? { token: exact.token, exchange: exact.exchange } : null;
  }

  private toSignalInput(messageId: string, channelId: string, p: Record<string, any>,
                        resolved: { token: string; exchange: string } | null, postedAt: Date): CreateSignalInput {
    const isDirectional = p.signalType === 'DIRECTIONAL';
    const leveledUntrackable = p.signalType === 'LEVELED' && p.slMode === 'NUMERIC'
      && p.stopLoss == null && (!Array.isArray(p.targets) || p.targets.length === 0);
    const tokenMissing = p.instrument !== 'OPTION' && !resolved;
    const status: CreateSignalInput['status'] =
      tokenMissing || leveledUntrackable ? 'UNTRACKABLE'
      : (isDirectional || p.entryMode === 'CMP') ? 'ACTIVE' : 'PENDING';

    return {
      messageId, channelId, symbol: String(p.symbol ?? ''),
      token: resolved?.token ?? null, exchange: resolved?.exchange ?? p.exchange ?? null,
      instrument: p.instrument, side: p.side, optionType: p.optionType ?? null,
      strike: p.strike ?? null, expiry: p.expiry ? new Date(p.expiry) : null,
      signalType: p.signalType, entryMode: p.entryMode,
      entryLow: p.entryLow ?? null, entryHigh: p.entryHigh ?? null,
      slMode: p.slMode, stopLoss: p.stopLoss ?? null,
      targets: Array.isArray(p.targets) ? p.targets : [],
      horizon: p.horizon, parseConfidence: Number(p.confidence) || 0,
      status, entryPrice: null,
      trackExpiresAt: this.computeExpiry(postedAt, p.horizon),
    };
  }

  private computeExpiry(postedAt: Date, horizon: string): Date {
    if (horizon === 'SWING') {
      const days = this.config.get<number>('telegram.swingTrackDays') ?? 10;
      return new Date(postedAt.getTime() + days * 24 * 3600_000);
    }
    // INTRADAY → 15:30 IST of the posted day
    const ist = new Date(postedAt.getTime() + IST_OFFSET_MS);
    const midnightUtc = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
    return new Date(midnightUtc + (15 * 60 + 30) * 60_000 - IST_OFFSET_MS);
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && npx jest telegram-ingest.service --silent`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the internal controller + its test**

Create `apps/api/src/modules/telegram/controllers/telegram-ingest.controller.ts`:

```ts
import {
  Body, Controller, Get, Headers, HttpCode, HttpStatus, Logger, Post,
  UnauthorizedException, UsePipes, ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { Public } from '../../../common/decorators';
import { TelegramIngestService } from '../services/telegram-ingest.service';
import { TelegramRepository } from '../repositories/telegram.repository';
import { TelegramIngestDto } from '../dto/telegram-ingest.dto';

export const TELEGRAM_INGEST_SECRET_HEADER = 'x-telegram-ingest-secret';

@Public()
@Controller('webhooks/telegram')
export class TelegramIngestController {
  private readonly logger = new Logger(TelegramIngestController.name);
  constructor(
    private readonly ingest: TelegramIngestService,
    private readonly repo: TelegramRepository,
    private readonly config: ConfigService,
  ) {}

  @Post('ingest')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async receive(
    @Headers(TELEGRAM_INGEST_SECRET_HEADER) secret: string | undefined,
    @Body() body: TelegramIngestDto,
  ) {
    this.assertAuthorized(secret);
    return this.ingest.ingest(body);
  }

  @Get('last-seen')
  async lastSeen(@Headers(TELEGRAM_INGEST_SECRET_HEADER) secret: string | undefined) {
    this.assertAuthorized(secret);
    return this.repo.lastSeenByChannel();
  }

  private assertAuthorized(provided: string | undefined): void {
    const expected = this.config.get<string>('TELEGRAM_INGEST_SECRET');
    if (!expected) { this.logger.warn('TELEGRAM_INGEST_SECRET unset — rejecting'); throw new UnauthorizedException(); }
    const p = provided ?? '';
    if (p.length !== expected.length || !timingSafeEqual(Buffer.from(p), Buffer.from(expected))) {
      this.logger.warn(`Telegram ingest auth failed (len=${p.length})`);
      throw new UnauthorizedException();
    }
  }
}
```

Create `apps/api/src/modules/telegram/controllers/telegram-ingest.controller.spec.ts`:

```ts
import { UnauthorizedException } from '@nestjs/common';
import { TelegramIngestController } from './telegram-ingest.controller';

function make(secret?: string) {
  const config = { get: jest.fn().mockReturnValue(secret) } as any;
  const ingest = { ingest: jest.fn().mockResolvedValue({ messageId: 'm', signalId: 's' }) } as any;
  const repo = { lastSeenByChannel: jest.fn().mockResolvedValue({}) } as any;
  return { c: new TelegramIngestController(ingest, repo, config), ingest };
}

it('rejects when secret env unset', async () => {
  const { c } = make(undefined);
  await expect(c.receive('anything', {} as any)).rejects.toBeInstanceOf(UnauthorizedException);
});
it('rejects on wrong secret', async () => {
  const { c } = make('rightsecret');
  await expect(c.receive('wrongsecret!', {} as any)).rejects.toBeInstanceOf(UnauthorizedException);
});
it('accepts on correct secret', async () => {
  const { c, ingest } = make('sekret');
  await expect(c.receive('sekret', { a: 1 } as any)).resolves.toEqual({ messageId: 'm', signalId: 's' });
  expect(ingest.ingest).toHaveBeenCalled();
});
```

- [ ] **Step 6: Run both suites**

Run: `cd apps/api && npx jest telegram-ingest --silent`
Expected: PASS (all).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/telegram/services/telegram-ingest.service.ts apps/api/src/modules/telegram/controllers/telegram-ingest.controller.ts apps/api/src/modules/telegram/services/telegram-ingest.service.spec.ts apps/api/src/modules/telegram/controllers/telegram-ingest.controller.spec.ts
git commit -m "feat(telegram): ingest service (dedup, resolve, enqueue) + secret-gated internal endpoint"
```

---

## Task 6: Outcome evaluation (pure functions)

**Files:**
- Create: `apps/api/src/modules/telegram/services/outcome-eval.ts`
- Test: `apps/api/src/modules/telegram/services/outcome-eval.spec.ts`

**Interfaces:**
- Produces:
  - `type Bar = { high: number; low: number; close: number; timestamp: Date }`
  - `interface EvalSignal { side: 'LONG'|'SHORT'; signalType: 'LEVELED'|'DIRECTIONAL'; entryLow: number|null; entryHigh: number|null; entryMode: string; stopLoss: number|null; slMode: string; targets: number[]; entryPrice: number|null; horizon: 'INTRADAY'|'SWING'; }`
  - `interface EvalResult { status: 'PENDING'|'ACTIVE'|'TARGET_HIT'|'SL_HIT'|'EXPIRED'; entryPrice?: number; entryFilledAt?: Date; exitPrice?: number; exitAt?: Date; hitTargetIndex?: number; resultPct?: number; }`
  - `evaluateLeveled(sig: EvalSignal, bars: Bar[]): EvalResult`
  - `evaluateDirectional(sig: EvalSignal, bars: Bar[], thresholds: { winPct: number; lossPct: number }): EvalResult`
  - `resultPct(entry: number, exit: number, side: 'LONG'|'SHORT'): number`
- Consumed by: Task 7 tracker.

- [ ] **Step 1: Write failing tests (tie-break, directional, expiry)**

Create `apps/api/src/modules/telegram/services/outcome-eval.spec.ts`:

```ts
import { evaluateLeveled, evaluateDirectional, resultPct } from './outcome-eval';

const bar = (high: number, low: number, t = '2026-07-20T05:00:00Z') =>
  ({ high, low, close: (high + low) / 2, timestamp: new Date(t) });

const leveled = (over: Partial<any> = {}) => ({
  side: 'LONG', signalType: 'LEVELED', entryLow: 100, entryHigh: 100, entryMode: 'NEAR',
  stopLoss: 95, slMode: 'NUMERIC', targets: [110], entryPrice: null, horizon: 'INTRADAY', ...over,
});

it('resultPct is signed by side', () => {
  expect(resultPct(100, 110, 'LONG')).toBeCloseTo(10);
  expect(resultPct(100, 90, 'SHORT')).toBeCloseTo(10);
});

it('fills entry then hits target', () => {
  const r = evaluateLeveled(leveled(), [bar(101, 99), bar(112, 108)]);
  expect(r.status).toBe('TARGET_HIT');
  expect(r.hitTargetIndex).toBe(0);
  expect(r.resultPct).toBeCloseTo(10);
});

it('SL-first tie-break: one bar touches both SL and target → SL_HIT', () => {
  const r = evaluateLeveled(leveled({ entryPrice: 100 }), [bar(112, 94)]); // already ACTIVE
  expect(r.status).toBe('SL_HIT');
  expect(r.resultPct).toBeCloseTo(-5);
});

it('never fills → EXPIRED', () => {
  const r = evaluateLeveled(leveled(), [bar(99, 97), bar(98, 96)]);
  expect(r.status).toBe('EXPIRED');
});

it('directional: +winPct before -lossPct → TARGET_HIT', () => {
  const sig = { side: 'LONG', signalType: 'DIRECTIONAL', entryPrice: 100, horizon: 'SWING' } as any;
  const r = evaluateDirectional(sig, [bar(105, 99), bar(109, 104)], { winPct: 8, lossPct: 5 });
  expect(r.status).toBe('TARGET_HIT');
});

it('directional: -lossPct first → SL_HIT', () => {
  const sig = { side: 'LONG', signalType: 'DIRECTIONAL', entryPrice: 100, horizon: 'SWING' } as any;
  const r = evaluateDirectional(sig, [bar(101, 94)], { winPct: 8, lossPct: 5 });
  expect(r.status).toBe('SL_HIT');
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd apps/api && npx jest outcome-eval --silent`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the pure evaluator**

Create `apps/api/src/modules/telegram/services/outcome-eval.ts`:

```ts
export type Bar = { high: number; low: number; close: number; timestamp: Date };

export interface EvalSignal {
  side: 'LONG' | 'SHORT';
  signalType: 'LEVELED' | 'DIRECTIONAL';
  entryLow: number | null; entryHigh: number | null; entryMode: string;
  stopLoss: number | null; slMode: string; targets: number[];
  entryPrice: number | null; horizon: 'INTRADAY' | 'SWING';
}

export interface EvalResult {
  status: 'PENDING' | 'ACTIVE' | 'TARGET_HIT' | 'SL_HIT' | 'EXPIRED';
  entryPrice?: number; entryFilledAt?: Date; exitPrice?: number; exitAt?: Date;
  hitTargetIndex?: number; resultPct?: number;
}

export function resultPct(entry: number, exit: number, side: 'LONG' | 'SHORT'): number {
  const raw = ((exit - entry) / entry) * 100;
  return side === 'LONG' ? raw : -raw;
}

function touched(bar: Bar, level: number, dir: 'up' | 'down'): boolean {
  return dir === 'up' ? bar.high >= level : bar.low <= level;
}

/** Entry fill price for a LEVELED signal on a bar that reaches the entry zone/trigger. */
function fillPrice(sig: EvalSignal): number {
  if (sig.entryPrice != null) return sig.entryPrice;
  if (sig.entryLow != null && sig.entryHigh != null) return (sig.entryLow + sig.entryHigh) / 2;
  return sig.entryLow ?? sig.entryHigh ?? 0;
}

export function evaluateLeveled(sig: EvalSignal, bars: Bar[]): EvalResult {
  const long = sig.side === 'LONG';
  let entry = sig.entryPrice;
  let entryFilledAt: Date | undefined;
  const entryTouch = Math.max(sig.entryLow ?? -Infinity, sig.entryHigh ?? -Infinity);
  const entryRef = sig.entryLow ?? sig.entryHigh ?? null;

  for (const bar of bars) {
    // 1. Fill entry if not yet filled.
    if (entry == null) {
      const hit = entryRef != null &&
        (long ? bar.low <= (sig.entryHigh ?? entryRef) : bar.high >= (sig.entryLow ?? entryRef));
      if (!hit) continue;
      entry = fillPrice(sig);
      entryFilledAt = bar.timestamp;
    }
    // 2. On the active bar, check SL first (conservative tie-break), then targets.
    const slHit = sig.slMode === 'NUMERIC' && sig.stopLoss != null &&
      (long ? bar.low <= sig.stopLoss : bar.high >= sig.stopLoss);
    if (slHit) {
      return { status: 'SL_HIT', entryPrice: entry, entryFilledAt, exitPrice: sig.stopLoss!,
        exitAt: bar.timestamp, resultPct: resultPct(entry, sig.stopLoss!, sig.side) };
    }
    for (let i = sig.targets.length - 1; i >= 0; i--) {
      const tgt = sig.targets[i];
      if (long ? bar.high >= tgt : bar.low <= tgt) {
        return { status: 'TARGET_HIT', entryPrice: entry, entryFilledAt, exitPrice: tgt,
          exitAt: bar.timestamp, hitTargetIndex: i, resultPct: resultPct(entry, tgt, sig.side) };
      }
    }
  }
  if (entry == null) return { status: 'EXPIRED' };
  return { status: 'ACTIVE', entryPrice: entry, entryFilledAt };
}

export function evaluateDirectional(sig: EvalSignal, bars: Bar[],
  thresholds: { winPct: number; lossPct: number }): EvalResult {
  if (sig.entryPrice == null) return { status: 'ACTIVE' };
  const long = sig.side === 'LONG';
  const winLvl = long ? sig.entryPrice * (1 + thresholds.winPct / 100) : sig.entryPrice * (1 - thresholds.winPct / 100);
  const lossLvl = long ? sig.entryPrice * (1 - thresholds.lossPct / 100) : sig.entryPrice * (1 + thresholds.lossPct / 100);
  for (const bar of bars) {
    // Loss checked first (conservative).
    if (touched(bar, lossLvl, long ? 'down' : 'up')) {
      return { status: 'SL_HIT', entryPrice: sig.entryPrice, exitPrice: lossLvl,
        exitAt: bar.timestamp, resultPct: resultPct(sig.entryPrice, lossLvl, sig.side) };
    }
    if (touched(bar, winLvl, long ? 'up' : 'down')) {
      return { status: 'TARGET_HIT', entryPrice: sig.entryPrice, exitPrice: winLvl,
        exitAt: bar.timestamp, resultPct: resultPct(sig.entryPrice, winLvl, sig.side) };
    }
  }
  return { status: 'ACTIVE', entryPrice: sig.entryPrice };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && npx jest outcome-eval --silent`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/telegram/services/outcome-eval.ts apps/api/src/modules/telegram/services/outcome-eval.spec.ts
git commit -m "feat(telegram): pure outcome evaluator (leveled intrabar SL-first, directional forward-return)"
```

---

## Task 7: Tracker service + cron poller + Bull worker

**Files:**
- Create: `apps/api/src/modules/telegram/services/telegram-tracker.service.ts`
- Create: `apps/api/src/modules/telegram/workers/telegram-track.processor.ts`
- Test: `apps/api/src/modules/telegram/services/telegram-tracker.service.spec.ts`

**Interfaces:**
- Consumes: `TelegramRepository`; `MarketDataRepository.getCandles(instrumentId, timeframe, from, to, take?)` (window-safe historical) — resolve `instrumentId` from token via `InstrumentService.getByToken(token)` which returns `{ id, ... }`; `OptionsChainService.getLiveOptionLtp(...)` for live option premium; `evaluateLeveled`/`evaluateDirectional` (Task 6); `TelegramGateway.emit(...)` (Task 8); `ConfigService` for thresholds.
- Produces: `TelegramTrackerService.evaluateOne(signalId: string): Promise<void>` (used by worker + cron); `TelegramTrackerService.pollActive(): Promise<void>` (`@Cron`).
- Thresholds from config: `telegram.directional.intraday = { winPct:3, lossPct:2 }`, `telegram.directional.swing = { winPct:8, lossPct:5 }`.

> **Hazard avoidance:** use `MarketDataRepository.getCandles(...)` (honors `[from,to]`), NOT `AngelOneAdapter.getHistoricalData(...)` (window-blind cache). Options with no candle history in DB and whose window is fully past → mark `UNTRACKABLE`.

- [ ] **Step 1: Write failing tracker test (leveled equity resolves TARGET_HIT via candles)**

Create `apps/api/src/modules/telegram/services/telegram-tracker.service.spec.ts`:

```ts
import { TelegramTrackerService } from './telegram-tracker.service';

function deps() {
  const signal = {
    id: 's1', token: '111', exchange: 'NSE', instrument: 'EQUITY', side: 'LONG',
    signalType: 'LEVELED', entryLow: 100, entryHigh: 100, entryMode: 'NEAR',
    stopLoss: 95, slMode: 'NUMERIC', targets: [110], entryPrice: null, horizon: 'INTRADAY',
    createdAt: new Date('2026-07-20T04:00:00Z'), trackExpiresAt: new Date('2026-07-20T10:00:00Z'),
  };
  const repo = {
    prisma: { telegramSignal: { findUnique: jest.fn().mockResolvedValue(signal) } },
    transition: jest.fn().mockResolvedValue(undefined),
    addEvent: jest.fn().mockResolvedValue(undefined),
    findActiveSignals: jest.fn().mockResolvedValue([signal]),
  } as any;
  const instruments = { getByToken: jest.fn().mockResolvedValue({ id: 'inst1' }) } as any;
  const marketRepo = { getCandles: jest.fn().mockResolvedValue([
    { high: 101, low: 99, close: 100, timestamp: new Date('2026-07-20T05:00:00Z') },
    { high: 112, low: 108, close: 110, timestamp: new Date('2026-07-20T06:00:00Z') },
  ]) } as any;
  const options = { getLiveOptionLtp: jest.fn() } as any;
  const gateway = { emit: jest.fn() } as any;
  const config = { get: jest.fn((k) => k.includes('swing') ? { winPct: 8, lossPct: 5 } : { winPct: 3, lossPct: 2 }) } as any;
  return { repo, instruments, marketRepo, options, gateway, config,
    svc: new TelegramTrackerService(repo, instruments, marketRepo, options, gateway, config) };
}

it('resolves a leveled equity signal to TARGET_HIT', async () => {
  const d = deps();
  await d.svc.evaluateOne('s1');
  expect(d.repo.transition).toHaveBeenCalledWith('s1',
    expect.objectContaining({ status: 'TARGET_HIT' }));
  expect(d.repo.addEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'TARGET_HIT' }));
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd apps/api && npx jest telegram-tracker --silent`
Expected: FAIL.

- [ ] **Step 3: Implement the tracker**

Create `apps/api/src/modules/telegram/services/telegram-tracker.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { TelegramRepository } from '../repositories/telegram.repository';
import { InstrumentService } from '../../market-data/services/instrument.service';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { OptionsChainService } from '../../options-chain/services/options-chain.service';
import { TelegramGateway } from '../gateways/telegram.gateway';
import { Bar, EvalSignal, evaluateDirectional, evaluateLeveled } from './outcome-eval';

@Injectable()
export class TelegramTrackerService {
  private readonly logger = new Logger(TelegramTrackerService.name);
  constructor(
    private readonly repo: TelegramRepository,
    private readonly instruments: InstrumentService,
    private readonly marketRepo: MarketDataRepository,
    private readonly options: OptionsChainService,
    private readonly gateway: TelegramGateway,
    private readonly config: ConfigService,
  ) {}

  @Cron('*/60 * 9-15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async pollActive(): Promise<void> {
    const active = await this.repo.findActiveSignals();
    for (const s of active) {
      try { await this.evaluateOne(s.id); }
      catch (e) { this.logger.warn(`evaluate ${s.id} failed: ${(e as Error).message}`); }
    }
  }

  async evaluateOne(signalId: string): Promise<void> {
    const s: any = await (this.repo as any).prisma.telegramSignal.findUnique({ where: { id: signalId } });
    if (!s || !['PENDING', 'ACTIVE'].includes(s.status)) return;

    // Expired guard.
    if (s.trackExpiresAt && Date.now() > new Date(s.trackExpiresAt).getTime()) {
      // fall through to evaluate over the full window, then EXPIRE if unresolved.
    }

    const bars = await this.loadBars(s);
    if (bars == null) { // untrackable (e.g. option, no history)
      await this.markUntrackable(signalId);
      return;
    }

    const evalSig: EvalSignal = {
      side: s.side, signalType: s.signalType, entryLow: s.entryLow, entryHigh: s.entryHigh,
      entryMode: s.entryMode, stopLoss: s.stopLoss, slMode: s.slMode, targets: s.targets,
      entryPrice: s.entryPrice, horizon: s.horizon,
    };
    const th = this.config.get<{ winPct: number; lossPct: number }>(
      `telegram.directional.${s.horizon === 'SWING' ? 'swing' : 'intraday'}`) ?? { winPct: 3, lossPct: 2 };
    const r = s.signalType === 'DIRECTIONAL'
      ? evaluateDirectional(evalSig, bars, th)
      : evaluateLeveled(evalSig, bars);

    // Terminal?
    if (r.status === 'TARGET_HIT' || r.status === 'SL_HIT') {
      await this.repo.transition(signalId, {
        status: r.status, entryPrice: r.entryPrice ?? s.entryPrice, entryFilledAt: r.entryFilledAt,
        exitPrice: r.exitPrice, exitAt: r.exitAt, hitTargetIndex: r.hitTargetIndex ?? null,
        resultPct: r.resultPct,
      });
      await this.repo.addEvent({ signalId, type: r.status, price: r.exitPrice, note: `result ${r.resultPct?.toFixed(2)}%` });
      this.gateway.emit('signal-update', { id: signalId, status: r.status, resultPct: r.resultPct });
      return;
    }

    // Not terminal — either advanced PENDING→ACTIVE, or expired.
    if (s.trackExpiresAt && Date.now() > new Date(s.trackExpiresAt).getTime()) {
      await this.repo.transition(signalId, { status: 'EXPIRED', entryPrice: r.entryPrice ?? s.entryPrice });
      await this.repo.addEvent({ signalId, type: 'EXPIRED' });
      this.gateway.emit('signal-update', { id: signalId, status: 'EXPIRED' });
      return;
    }
    if (r.status === 'ACTIVE' && s.status === 'PENDING') {
      await this.repo.transition(signalId, { status: 'ACTIVE', entryPrice: r.entryPrice, entryFilledAt: r.entryFilledAt });
      await this.repo.addEvent({ signalId, type: 'ENTRY_FILLED', price: r.entryPrice });
    }
  }

  /** Returns candle bars for the signal's window, or null if untrackable. */
  private async loadBars(s: any): Promise<Bar[] | null> {
    if (s.instrument === 'OPTION') {
      // Phase 1: live premium only. If the window is entirely past, we have no
      // stored option candles → untrackable. If live, sample the premium as a 1-bar.
      const past = s.trackExpiresAt && Date.now() > new Date(s.trackExpiresAt).getTime();
      if (past || !s.expiry) return null;
      const ltp = await this.options.getLiveOptionLtp(
        s.symbol, new Date(s.expiry).toISOString(), s.strike, s.optionType);
      if (ltp == null) return null;
      const now = new Date();
      return [{ high: ltp, low: ltp, close: ltp, timestamp: now }];
    }
    if (!s.token) return null;
    const inst = await this.instruments.getByToken(s.token);
    if (!inst) return null;
    const tf = s.horizon === 'SWING' ? '1day' : '15minute';
    const to = s.trackExpiresAt ? new Date(Math.min(Date.now(), new Date(s.trackExpiresAt).getTime())) : new Date();
    const bars = await this.marketRepo.getCandles(inst.id, tf, new Date(s.createdAt), to);
    return (bars ?? []).map((b: any) => ({
      high: Number(b.high), low: Number(b.low), close: Number(b.close), timestamp: new Date(b.timestamp),
    }));
  }

  private async markUntrackable(signalId: string): Promise<void> {
    await this.repo.transition(signalId, { status: 'UNTRACKABLE' });
    await this.repo.addEvent({ signalId, type: 'UNTRACKABLE', note: 'no price history available' });
  }
}
```

- [ ] **Step 4: Write the worker**

Create `apps/api/src/modules/telegram/workers/telegram-track.processor.ts`:

```ts
import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { TelegramTrackerService } from '../services/telegram-tracker.service';
import { TelegramTrackJobData } from '../services/telegram-ingest.service';

@Processor('telegram-track')
export class TelegramTrackProcessor {
  private readonly logger = new Logger(TelegramTrackProcessor.name);
  constructor(private readonly tracker: TelegramTrackerService) {}

  @Process('track')
  async handle(job: Job<TelegramTrackJobData>): Promise<void> {
    await this.tracker.evaluateOne(job.data.signalId);
  }
}
```

- [ ] **Step 5: Run to verify pass**

Run: `cd apps/api && npx jest telegram-tracker --silent`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/telegram/services/telegram-tracker.service.ts apps/api/src/modules/telegram/workers/telegram-track.processor.ts apps/api/src/modules/telegram/services/telegram-tracker.service.spec.ts
git commit -m "feat(telegram): outcome tracker (cron poll + Bull worker) via window-safe getCandles"
```

---

## Task 8: Stats service + admin controller + gateway + module wiring + config

**Files:**
- Create: `apps/api/src/modules/telegram/services/telegram-stats.service.ts`
- Create: `apps/api/src/modules/telegram/controllers/telegram.controller.ts`
- Create: `apps/api/src/modules/telegram/gateways/telegram.gateway.ts`
- Create: `apps/api/src/modules/telegram/telegram.module.ts`
- Modify: `apps/api/src/app.module.ts`, `apps/api/src/config/configuration.ts`, `apps/api/src/common/config/validate-boot-config.ts`, `.env.example`
- Test: `apps/api/src/modules/telegram/services/telegram-stats.service.spec.ts`

**Interfaces:**
- Produces: `TelegramStatsService.channelScorecards(): Promise<ChannelScorecard[]>` where `ChannelScorecard = { channelId; title; total; wins; losses; expired; untrackable; winRate: number | null; avgResultPct: number | null }`. `winRate` = `wins/(wins+losses)` or `null` when `wins+losses < minSample` (config `telegram.minSample`, default 5).
- `TelegramGateway.emit(event: string, payload: unknown): void` (namespace `/ws/telegram`).
- Controller routes (class `@AdminOnly()`, `@Controller('api/telegram')`): `GET /channels`, `GET /leaderboard`, `GET /signals?channelId&status&limit`.

- [ ] **Step 1: Write failing stats test (min-sample guard + exclusions)**

Create `apps/api/src/modules/telegram/services/telegram-stats.service.spec.ts`:

```ts
import { TelegramStatsService } from './telegram-stats.service';

function make(minSample = 5) {
  const repo = {
    listChannels: jest.fn().mockResolvedValue([{ id: 'c1', title: 'Mr P' }]),
    statsByChannel: jest.fn().mockResolvedValue([
      { channelId: 'c1', status: 'TARGET_HIT', _count: { _all: 6 }, _avg: { resultPct: 7 } },
      { channelId: 'c1', status: 'SL_HIT', _count: { _all: 2 }, _avg: { resultPct: -3 } },
      { channelId: 'c1', status: 'EXPIRED', _count: { _all: 3 }, _avg: { resultPct: null } },
      { channelId: 'c1', status: 'UNTRACKABLE', _count: { _all: 4 }, _avg: { resultPct: null } },
    ]),
  } as any;
  const config = { get: jest.fn().mockReturnValue(minSample) } as any;
  return new TelegramStatsService(repo, config);
}

it('win rate excludes EXPIRED/UNTRACKABLE and honors the ratio', async () => {
  const s = await make().channelScorecards();
  expect(s[0].winRate).toBeCloseTo(6 / 8); // 0.75
  expect(s[0].expired).toBe(3);
  expect(s[0].untrackable).toBe(4);
});

it('winRate is null below the minimum sample size', async () => {
  const s = await make(20).channelScorecards();
  expect(s[0].winRate).toBeNull();
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd apps/api && npx jest telegram-stats --silent`
Expected: FAIL.

- [ ] **Step 3: Implement the stats service**

Create `apps/api/src/modules/telegram/services/telegram-stats.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramRepository } from '../repositories/telegram.repository';

export interface ChannelScorecard {
  channelId: string; title: string; total: number; wins: number; losses: number;
  expired: number; untrackable: number; winRate: number | null; avgResultPct: number | null;
}

@Injectable()
export class TelegramStatsService {
  constructor(
    private readonly repo: TelegramRepository,
    private readonly config: ConfigService,
  ) {}

  async channelScorecards(): Promise<ChannelScorecard[]> {
    const minSample = this.config.get<number>('telegram.minSample') ?? 5;
    const channels = await this.repo.listChannels();
    const grouped = await this.repo.statsByChannel();
    const byChannel = new Map<string, any[]>();
    for (const g of grouped) {
      const arr = byChannel.get(g.channelId) ?? [];
      arr.push(g); byChannel.set(g.channelId, arr);
    }
    return channels.map((c) => {
      const rows = byChannel.get(c.id) ?? [];
      const count = (st: string) => rows.find((r) => r.status === st)?._count?._all ?? 0;
      const wins = count('TARGET_HIT'), losses = count('SL_HIT');
      const resolved = wins + losses;
      const avgs = rows.filter((r) => r._avg?.resultPct != null);
      const avgResultPct = avgs.length
        ? avgs.reduce((a, r) => a + r._avg.resultPct * r._count._all, 0) /
          avgs.reduce((a, r) => a + r._count._all, 0)
        : null;
      return {
        channelId: c.id, title: c.title,
        total: rows.reduce((a, r) => a + r._count._all, 0),
        wins, losses, expired: count('EXPIRED'), untrackable: count('UNTRACKABLE'),
        winRate: resolved >= minSample ? wins / resolved : null,
        avgResultPct,
      };
    });
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && npx jest telegram-stats --silent`
Expected: PASS.

- [ ] **Step 5: Gateway, admin controller, module, config (no new tests — covered by build + existing patterns)**

Create `apps/api/src/modules/telegram/gateways/telegram.gateway.ts`:

```ts
import { WebSocketGateway, WebSocketServer, OnGatewayConnection } from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { isAdminSocket } from '../../../common/ws/authenticate-admin-socket';

const CORS_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:4000';

@WebSocketGateway({ cors: { origin: CORS_ORIGIN, credentials: true }, namespace: '/ws/telegram' })
export class TelegramGateway implements OnGatewayConnection {
  private readonly logger = new Logger(TelegramGateway.name);
  @WebSocketServer() server!: Server;

  handleConnection(client: Socket) {
    if (!isAdminSocket(client)) client.disconnect(true);
  }

  emit(event: string, payload: unknown) {
    this.server?.emit(`telegram:${event}`, payload);
  }
}
```

Create `apps/api/src/modules/telegram/controllers/telegram.controller.ts`:

```ts
import { Controller, Get, Query } from '@nestjs/common';
import { AdminOnly } from '../../../common/decorators';
import { TelegramRepository } from '../repositories/telegram.repository';
import { TelegramStatsService } from '../services/telegram-stats.service';

@AdminOnly()
@Controller('api/telegram')
export class TelegramController {
  constructor(
    private readonly repo: TelegramRepository,
    private readonly stats: TelegramStatsService,
  ) {}

  @Get('channels') listChannels() { return this.repo.listChannels(); }
  @Get('leaderboard') leaderboard() { return this.stats.channelScorecards(); }

  @Get('signals')
  listSignals(@Query('channelId') channelId?: string, @Query('status') status?: string,
    @Query('limit') limit = '50') {
    return this.repo.listSignals({ channelId, status, limit: Math.min(Number(limit) || 50, 200) });
  }
}
```

Create `apps/api/src/modules/telegram/telegram.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { OptionsChainModule } from '../options-chain/options-chain.module';
import { TelegramRepository } from './repositories/telegram.repository';
import { TelegramIngestService } from './services/telegram-ingest.service';
import { TelegramTrackerService } from './services/telegram-tracker.service';
import { TelegramStatsService } from './services/telegram-stats.service';
import { TelegramTrackProcessor } from './workers/telegram-track.processor';
import { TelegramGateway } from './gateways/telegram.gateway';
import { TelegramIngestController } from './controllers/telegram-ingest.controller';
import { TelegramController } from './controllers/telegram.controller';

@Module({
  imports: [
    PrismaModule, MarketDataModule, OptionsChainModule,
    BullModule.registerQueue({ name: 'telegram-track' }),
  ],
  controllers: [TelegramIngestController, TelegramController],
  providers: [
    TelegramRepository, TelegramIngestService, TelegramTrackerService,
    TelegramStatsService, TelegramTrackProcessor, TelegramGateway,
  ],
  exports: [TelegramRepository],
})
export class TelegramModule {}
```

> If `MarketDataModule`/`OptionsChainModule` do not export `InstrumentService`/`MarketDataRepository`/`OptionsChainService`, add them to those modules' `exports` arrays (verify at implementation; both are used cross-module elsewhere so likely already exported).

Register in `apps/api/src/app.module.ts`: add `import { TelegramModule } from './modules/telegram/telegram.module';` near the other module imports (~line 30) and add `TelegramModule,` to the `imports:` array (~line 165).

Add to `apps/api/src/config/configuration.ts` (inside the returned object):

```ts
telegram: {
  minConfidence: parseFloat(process.env.TELEGRAM_MIN_CONFIDENCE || '0.55'),
  minSample: parseInt(process.env.TELEGRAM_MIN_SAMPLE || '5', 10),
  swingTrackDays: parseInt(process.env.TELEGRAM_SWING_TRACK_DAYS || '10', 10),
  directional: {
    intraday: { winPct: 3, lossPct: 2 },
    swing: { winPct: 8, lossPct: 5 },
  },
},
```

Add to `apps/api/src/common/config/validate-boot-config.ts` production gate:

```ts
if (env.NODE_ENV === 'production' && !env.TELEGRAM_INGEST_SECRET) {
  fail.push('TELEGRAM_INGEST_SECRET is required in production');
}
```

Append to `.env.example`:

```
# --- Telegram signal scorecard ---
TELEGRAM_INGEST_SECRET=
TELEGRAM_MIN_CONFIDENCE=0.55
TELEGRAM_MIN_SAMPLE=5
TELEGRAM_SWING_TRACK_DAYS=10
# ai-engine listener side:
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
TELEGRAM_SESSION=
TELEGRAM_WATCH_CHANNELS=
TELEGRAM_INGEST_URL=http://localhost:3001/webhooks/telegram/ingest
ANTHROPIC_API_KEY=
```

- [ ] **Step 6: Build the whole API**

Run: `cd apps/api && npx tsc -p tsconfig.json --noEmit && npx jest telegram --silent`
Expected: no type errors; all `telegram` suites PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/telegram apps/api/src/app.module.ts apps/api/src/config/configuration.ts apps/api/src/common/config/validate-boot-config.ts .env.example
git commit -m "feat(telegram): stats scorecard, admin API, gateway, module wiring + config"
```

---

## Task 9: Instrument-master refresh cron (prerequisite — reduces UNTRACKABLE)

**Files:**
- Create: `apps/api/src/modules/market-data/services/instrument-master-refresh.cron.ts`
- Modify: `apps/api/src/modules/market-data/market-data.module.ts` (register provider)
- Test: `apps/api/src/modules/market-data/services/instrument-master-refresh.cron.spec.ts`

**Interfaces:**
- Consumes: `InstrumentService.refreshMaster(rawInstruments?)`; the broker adapter's instrument-master fetch (verify method name on `AngelOneAdapterService` — the master list the adapter loads at boot). If the adapter exposes no public "get raw master" method, call `refreshMaster()` with the adapter's already-loaded in-memory master (add a small getter). 
- Produces: `InstrumentMasterRefreshCron.refreshDaily()` (`@Cron` daily pre-open) + `onModuleInit()` one-shot at boot.

> This task is INDEPENDENT of Tasks 1–8 and can run in parallel or be deferred. Without it, unlisted symbols become `UNTRACKABLE` (a real but non-blocking degradation). If the adapter's raw-master accessor is unclear, keep this task's scope to: call `refreshMaster()` on a daily `@Cron('0 0 8 * * 1-5', { timeZone: 'Asia/Kolkata' })` and at `onModuleInit`, sourcing instruments from the adapter's existing loaded master.

- [ ] **Step 1: Write failing test**

```ts
import { InstrumentMasterRefreshCron } from './instrument-master-refresh.cron';

it('calls refreshMaster on boot', async () => {
  const instrument = { refreshMaster: jest.fn().mockResolvedValue(1200) } as any;
  const adapter = { getLoadedMaster: jest.fn().mockReturnValue([{ symbol: 'X' }]) } as any;
  const cron = new InstrumentMasterRefreshCron(instrument, adapter);
  await cron.onModuleInit();
  expect(instrument.refreshMaster).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd apps/api && npx jest instrument-master-refresh --silent`
Expected: FAIL.

- [ ] **Step 3: Implement (adapt accessor name to the real adapter after verification)**

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InstrumentService } from './instrument.service';
import { AngelOneAdapterService } from './angel-one-adapter.service';

@Injectable()
export class InstrumentMasterRefreshCron implements OnModuleInit {
  private readonly logger = new Logger(InstrumentMasterRefreshCron.name);
  constructor(
    private readonly instruments: InstrumentService,
    private readonly adapter: AngelOneAdapterService,
  ) {}

  async onModuleInit(): Promise<void> { await this.refresh('boot'); }

  @Cron('0 0 8 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async refreshDaily(): Promise<void> { await this.refresh('daily'); }

  private async refresh(trigger: string): Promise<void> {
    try {
      const raw = (this.adapter as any).getLoadedMaster?.() ?? undefined;
      const n = await this.instruments.refreshMaster(raw);
      this.logger.log(`Instrument master refreshed (${trigger}): ${n} rows`);
    } catch (e) {
      this.logger.warn(`Instrument master refresh (${trigger}) failed: ${(e as Error).message}`);
    }
  }
}
```

Register it in `market-data.module.ts` `providers`. If `getLoadedMaster` does not exist on the adapter, add a public getter returning the in-memory master array the adapter already loads at boot.

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && npx jest instrument-master-refresh --silent`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/market-data/services/instrument-master-refresh.cron.ts apps/api/src/modules/market-data/services/instrument-master-refresh.cron.spec.ts apps/api/src/modules/market-data/market-data.module.ts
git commit -m "fix(market-data): wire instrument-master refresh on boot + daily cron"
```

---

## Task 10: Web — types, API service, data hook

**Files:**
- Modify: `apps/web/src/types/index.ts`
- Create: `apps/web/src/services/telegram.ts`
- Create: `apps/web/src/hooks/useTelegramScorecard.ts`
- Test: `apps/web/src/services/telegram.spec.ts`

**Interfaces:**
- Produces types `TelegramChannel`, `TelegramSignalRow`, `ChannelScorecard`; service fns `listTelegramChannels()`, `getLeaderboard()`, `listTelegramSignals(params)`; hook `useTelegramScorecard()` returning `{ scorecards, channels, signals, isLoading, refresh }`.

- [ ] **Step 1: Add types to `apps/web/src/types/index.ts`**

```ts
export interface TelegramChannel {
  id: string; tgChannelId: string; username: string | null; title: string;
  isActive: boolean; addedAt: string;
}
export interface ChannelScorecard {
  channelId: string; title: string; total: number; wins: number; losses: number;
  expired: number; untrackable: number; winRate: number | null; avgResultPct: number | null;
}
export interface TelegramSignalRow {
  id: string; symbol: string; instrument: string; side: string; signalType: string;
  status: string; resultPct: number | null; createdAt: string;
  message?: { rawText: string; postedAt: string };
}
```

- [ ] **Step 2: Write failing service test**

Create `apps/web/src/services/telegram.spec.ts`:

```ts
import { vi, it, expect } from 'vitest';
vi.mock('./api', () => ({ default: { get: vi.fn().mockResolvedValue({ data: [{ channelId: 'c1' }] }) } }));
import api from './api';
import { getLeaderboard } from './telegram';

it('getLeaderboard hits /telegram/leaderboard', async () => {
  const r = await getLeaderboard();
  expect((api as any).get).toHaveBeenCalledWith('/telegram/leaderboard');
  expect(r[0].channelId).toBe('c1');
});
```

- [ ] **Step 3: Run to verify fail**

Run: `cd apps/web && npx vitest run src/services/telegram.spec.ts`
Expected: FAIL — `telegram.ts` missing.

- [ ] **Step 4: Implement service + hook**

Create `apps/web/src/services/telegram.ts`:

```ts
import api from './api';
import type { TelegramChannel, ChannelScorecard, TelegramSignalRow } from '../types';

export async function listTelegramChannels(): Promise<TelegramChannel[]> {
  const r = await api.get<TelegramChannel[]>('/telegram/channels');
  return r.data;
}
export async function getLeaderboard(): Promise<ChannelScorecard[]> {
  const r = await api.get<ChannelScorecard[]>('/telegram/leaderboard');
  return r.data;
}
export async function listTelegramSignals(
  params: { channelId?: string; status?: string; limit?: number } = {},
): Promise<TelegramSignalRow[]> {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
  const r = await api.get<TelegramSignalRow[]>('/telegram/signals', { params: clean });
  return r.data;
}
```

Create `apps/web/src/hooks/useTelegramScorecard.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';
import { getLeaderboard, listTelegramChannels, listTelegramSignals } from '../services/telegram';
import type { ChannelScorecard, TelegramChannel, TelegramSignalRow } from '../types';

export function useTelegramScorecard() {
  const [scorecards, setScorecards] = useState<ChannelScorecard[]>([]);
  const [channels, setChannels] = useState<TelegramChannel[]>([]);
  const [signals, setSignals] = useState<TelegramSignalRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const [sc, ch, sig] = await Promise.all([
        getLeaderboard(), listTelegramChannels(), listTelegramSignals({ limit: 100 }),
      ]);
      setScorecards(sc); setChannels(ch); setSignals(sig);
    } catch { /* interceptor toasts */ }
    finally { setIsLoading(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  return { scorecards, channels, signals, isLoading, refresh };
}
```

- [ ] **Step 5: Run to verify pass**

Run: `cd apps/web && npx vitest run src/services/telegram.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/types/index.ts apps/web/src/services/telegram.ts apps/web/src/services/telegram.spec.ts apps/web/src/hooks/useTelegramScorecard.ts
git commit -m "feat(web): telegram scorecard types, API service, data hook"
```

---

## Task 11: Web — Telegram Signals page + route + nav + ws namespace

**Files:**
- Create: `apps/web/src/pages/telegram/TelegramSignalsPage.tsx`
- Modify: `apps/web/src/App.tsx` (import + `<Route>`)
- Modify: `apps/web/src/components/layout/navItems.ts` (nav entry)
- Modify: `apps/web/src/services/websocket.ts` (add `/ws/telegram` namespace)

**Interfaces:**
- Consumes: `useTelegramScorecard()` (Task 10); shared `DataTable`, `Badge`, `StatCard`, `EmptyState` from `@/components/common`.

- [ ] **Step 1: Build the page**

Create `apps/web/src/pages/telegram/TelegramSignalsPage.tsx`:

```tsx
import { useState } from 'react';
import { Send } from 'lucide-react';
import { DataTable, Badge, StatCard, EmptyState, LoadingSkeleton } from '@/components/common';
import type { Column } from '@/components/common/DataTable';
import { useTelegramScorecard } from '@/hooks/useTelegramScorecard';
import type { ChannelScorecard, TelegramSignalRow } from '@/types';

const statusVariant: Record<string, 'success' | 'danger' | 'warning' | 'neutral' | 'info'> = {
  TARGET_HIT: 'success', SL_HIT: 'danger', EXPIRED: 'warning',
  UNTRACKABLE: 'neutral', ACTIVE: 'info', PENDING: 'info',
};

export default function TelegramSignalsPage() {
  const { scorecards, signals, isLoading, refresh } = useTelegramScorecard();
  const [tab, setTab] = useState<'leaderboard' | 'signals'>('leaderboard');

  const boardCols: Column<ChannelScorecard & Record<string, unknown>>[] = [
    { key: 'title', header: 'Channel' },
    { key: 'winRate', header: 'Win rate',
      render: (r) => r.winRate == null ? <span className="text-gray-500">—</span>
        : <Badge label={`${(r.winRate * 100).toFixed(0)}%`} variant={r.winRate >= 0.5 ? 'success' : 'danger'} /> },
    { key: 'wins', header: 'W' }, { key: 'losses', header: 'L' },
    { key: 'expired', header: 'Exp' }, { key: 'untrackable', header: 'Untr.' },
    { key: 'avgResultPct', header: 'Avg %',
      render: (r) => r.avgResultPct == null ? '—' : `${r.avgResultPct.toFixed(2)}%` },
  ];
  const signalCols: Column<TelegramSignalRow & Record<string, unknown>>[] = [
    { key: 'symbol', header: 'Symbol' },
    { key: 'signalType', header: 'Type' },
    { key: 'side', header: 'Side' },
    { key: 'status', header: 'Status',
      render: (r) => <Badge label={r.status} variant={statusVariant[r.status] ?? 'neutral'} /> },
    { key: 'resultPct', header: 'Result',
      render: (r) => r.resultPct == null ? '—' : `${r.resultPct.toFixed(2)}%` },
    { key: 'createdAt', header: 'When', render: (r) => new Date(r.createdAt).toLocaleString() },
  ];

  return (
    <div className="p-6 space-y-4">
      <header className="flex items-center gap-2">
        <Send className="w-5 h-5 text-blue-400" />
        <h1 className="text-lg font-semibold">Telegram Signals</h1>
        <button onClick={refresh} className="ml-auto text-sm px-3 py-1 rounded bg-gray-800/60 border border-gray-700/60">
          Refresh
        </button>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard title="Channels" value={scorecards.length} trend="flat" />
        <StatCard title="Signals" value={signals.length} trend="flat" />
      </div>

      <div className="flex gap-2">
        {(['leaderboard', 'signals'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-3 py-1 rounded text-sm ${tab === t ? 'bg-blue-600' : 'bg-gray-800/60'}`}>
            {t === 'leaderboard' ? 'Leaderboard' : 'Signals feed'}
          </button>
        ))}
      </div>

      {isLoading ? <LoadingSkeleton variant="card" />
        : tab === 'leaderboard'
          ? (scorecards.length ? <DataTable columns={boardCols} data={scorecards as any} />
            : <EmptyState title="No channels tracked yet" />)
          : (signals.length ? <DataTable columns={signalCols} data={signals as any} />
            : <EmptyState title="No signals yet" />)}
    </div>
  );
}
```

- [ ] **Step 2: Register the route in `App.tsx`**

Add import near the other page imports (~line 15):
```tsx
import TelegramSignalsPage from './pages/telegram/TelegramSignalsPage';
```
Add the route inside the authenticated layout `<Routes>` (near the other admin routes, ~line 152):
```tsx
<Route path="telegram" element={<RequireRole role="ADMIN"><TelegramSignalsPage /></RequireRole>} />
```

- [ ] **Step 3: Add the nav entry in `navItems.ts`**

Add to the `navItems` array (do NOT add to `USER_VISIBLE` — keeps it admin-only):
```ts
{ path: '/telegram', label: 'Telegram Signals', icon: Send, badge: 'EXP' },
```
Ensure `Send` is imported from `lucide-react` at the top of the file (the frontend agent confirmed it already is; add it if not).

- [ ] **Step 4: Add the ws namespace in `services/websocket.ts`**

Add an entry to the `NAMESPACES` array:
```ts
{ path: '/ws/telegram', events: ['telegram:signal-update'] as const },
```
(Match the exact shape of the existing `NAMESPACES` entries; the class auto-wires `sock.on(event, …)`.)

- [ ] **Step 5: Build the web app**

Run: `cd apps/web && npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: no type errors; tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/telegram apps/web/src/App.tsx apps/web/src/components/layout/navItems.ts apps/web/src/services/websocket.ts
git commit -m "feat(web): admin Telegram Signals section (leaderboard + feed) with route, nav, ws"
```

---

## Task 12: End-to-end wiring check + docs

**Files:**
- Modify: `docs/superpowers/specs/2026-07-20-telegram-signal-scorecard-design.md` (mark implemented)
- Create: `docs/guides/telegram-listener-runbook.md`

- [ ] **Step 1: Full build + test sweep**

Run: `cd apps/api && npx jest telegram --silent && cd ../../ai-engine && python -m pytest tests/test_telegram_parser.py tests/test_telegram_listener.py -v && cd ../apps/web && npx vitest run src/services/telegram.spec.ts`
Expected: all green.

- [ ] **Step 2: Write the runbook**

Create `docs/guides/telegram-listener-runbook.md` covering: one-time session generation (a short Telethon login script producing the `StringSession`, stored encrypted / set as `TELEGRAM_SESSION`), env vars, joining channels + collecting their numeric ids into `TELEGRAM_WATCH_CHANNELS`, running `python -m src.telegram_listener_main`, and the free-now / promote-to-always-on-worker note.

- [ ] **Step 3: Commit**

```bash
git add docs/guides/telegram-listener-runbook.md docs/superpowers/specs/2026-07-20-telegram-signal-scorecard-design.md
git commit -m "docs(telegram): listener runbook + mark spec implemented"
```

---

## Self-Review

**Spec coverage:** §3 architecture → Tasks 2,3,5,8. §4 watch mechanism → Task 3 (live + backfill). §5 data model → Task 1. §6 parsing → Task 2 (golden-set). §7 token resolution + hazard → Task 5 (`resolveToken`) + Task 9 (refresh). §8 outcome eval + cache hazard → Task 6 (pure) + Task 7 (uses window-safe `getCandles`, not the hazardous adapter). §9 win-rate → Task 8 stats. §10 admin UI → Tasks 10–11. §11 security → Task 5 (secret) + Task 8 (AdminOnly/gateway) + session encryption in runbook (Task 12) using `encryptField`. §12 resilience → Task 3 backfill + Task 4 idempotent insert. §13 testing → each task. §14 deployment → Task 8 config + Task 12 runbook.

**Placeholder scan:** No TBD/TODO. Task 9's adapter-accessor name is explicitly flagged for verification with a concrete fallback; Task 2 flags the `claude-api` skill for the Anthropic call. These are verification notes, not gaps.

**Type consistency:** `TelegramTrackJobData` produced in Task 5, consumed in Task 7. `CreateSignalInput` produced in Task 4, consumed in Task 5. `EvalSignal`/`EvalResult`/`evaluateLeveled`/`evaluateDirectional`/`resultPct` produced in Task 6, consumed in Task 7. `ChannelScorecard` shape identical in Task 8 (API) and Task 10 (web type). Status string set consistent everywhere: `PENDING|ACTIVE|TARGET_HIT|SL_HIT|EXPIRED|UNTRACKABLE|INVALIDATED`.

## Parallelization map (for a team of agents)

- **Wave 1 (unblocked):** Task 1 (schema), Task 2 (parser), Task 9 (instrument refresh). Task 2 and 9 have no dependency on Task 1.
- **Wave 2:** Task 3 (needs 2's contract), Task 4 (needs 1).
- **Wave 3:** Task 5 (needs 4), Task 6 (pure, needs nothing but is used by 7).
- **Wave 4:** Task 7 (needs 4,5,6), then Task 8 (needs 4,7,8-siblings).
- **Wave 5:** Task 10 (needs 8's API shape — can start from the documented `ChannelScorecard`), Task 11 (needs 10).
- **Wave 6:** Task 12 (needs all).
