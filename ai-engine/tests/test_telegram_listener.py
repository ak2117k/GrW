"""Unit test for the Telethon listener's pure payload builder.

Fully offline: it imports only ``build_ingest_payload`` and never touches
Telegram or the network. ``telethon`` need not be installed — the module keeps
its ``telethon`` imports lazy inside ``run()``/``backfill()``.
"""

from src.services.telegram_listener import build_ingest_payload


def test_build_ingest_payload_maps_fields():
    channel = {"tgChannelId": "-100123", "username": "mrpinvest", "title": "Mr P"}
    message = {"tgMessageId": 42, "rawText": "BUY X", "postedAt": "2026-07-20T10:00:00Z"}
    parsed = {"isSignal": True, "symbol": "X", "confidence": 0.8}
    p = build_ingest_payload(channel, message, parsed)
    assert p["channel"]["tgChannelId"] == "-100123"
    assert p["message"]["tgMessageId"] == 42
    assert p["parsed"]["symbol"] == "X"
