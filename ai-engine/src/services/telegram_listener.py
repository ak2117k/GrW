"""Persistent Telethon listener → parse (in-process) → forward to NestJS ingest.

Holds a long-lived MTProto connection to admin-curated Telegram channels. For
each new (or backfilled) message it parses the text IN-PROCESS via the Claude
Agent SDK (``parse_signal`` — authenticated by the host's Claude login), then
POSTs the structured signal to the NestJS ingest endpoint over a shared-secret
header. No separate parser HTTP service is needed.

``telethon`` is imported lazily inside ``run()``/``backfill()`` and the Agent SDK
lazily inside ``parse_signal._call_llm`` so this module imports (and its pure
``build_ingest_payload`` unit-tests) with no telethon / claude-agent-sdk
installed and no network access.
"""
import logging
import os
from typing import Any, Dict, List

import httpx

from .telegram_parser_service import parse_signal

logger = logging.getLogger("telegram_listener")


def build_ingest_payload(channel: Dict[str, Any], message: Dict[str, Any],
                         parsed: Dict[str, Any]) -> Dict[str, Any]:
    return {"channel": channel, "message": message, "parsed": parsed}


class TelegramListener:
    def __init__(self) -> None:
        self.ingest_url = os.environ["TELEGRAM_INGEST_URL"]
        self.ingest_secret = os.environ["TELEGRAM_INGEST_SECRET"]
        self.watch = [c.strip() for c in os.environ.get("TELEGRAM_WATCH_CHANNELS", "").split(",") if c.strip()]
        self._http = httpx.AsyncClient(timeout=90)  # tolerate Render free-tier cold-start wakes

    async def parse(self, text: str) -> Dict[str, Any]:
        """Parse in-process via the Claude Agent SDK (uses the host's Claude login)."""
        return await parse_signal(text)

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
        logger.info("forwarded msg %s from %s (isSignal=%s)",
                    message.get("tgMessageId"), channel.get("title"), parsed.get("isSignal"))

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
        limit = int(os.environ.get("TELEGRAM_BACKFILL_LIMIT", "50"))
        for ch in watched:
            min_id = int(last_seen.get(str(ch), 0))
            # Newest `limit` messages above min_id, replayed oldest→newest so the
            # server-side lastSeen pointer advances monotonically. Caps the cold-start
            # backfill so a first run doesn't parse a channel's entire history.
            recent = []
            async for msg in client.iter_messages(ch, limit=limit, min_id=min_id):
                recent.append(msg)
            for msg in reversed(recent):
                try:
                    chat = await msg.get_chat()
                    await self.handle_message(
                        {"tgChannelId": str(ch), "username": getattr(chat, "username", None),
                         "title": getattr(chat, "title", str(ch))},
                        {"tgMessageId": msg.id, "rawText": msg.message or "",
                         "postedAt": msg.date.isoformat()},
                    )
                except Exception as exc:  # noqa: BLE001 — one failed message must not stop backfill
                    logger.warning("backfill msg %s failed: %s", msg.id, exc)
