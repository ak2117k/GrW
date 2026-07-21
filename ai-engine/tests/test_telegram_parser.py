"""Golden-set tests for the Telegram signal parser.

These tests monkeypatch the service's ``_call_llm`` seam, so they run fully
offline — no Claude subscription login and no network. The async coroutines
are driven with ``asyncio.run`` so the suite needs no pytest-asyncio plugin.
"""

import asyncio

from src.services import telegram_parser_service as svc


def test_leveled_multi_target_crudeoil(monkeypatch):
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
    out = asyncio.run(
        svc.parse_signal("BUY CRUDEOIL 9500 CE / NEAR 225 / TARGET 240/260/300 / STOPLOSS PAID")
    )
    assert out["signalType"] == "LEVELED"
    assert out["slMode"] == "PREMIUM_PAID"
    assert out["targets"] == [240, 260, 300]


def test_directional_no_levels(monkeypatch):
    async def fake_llm(_text):
        return {
            "isSignal": True, "symbol": "SGMART", "instrument": "EQUITY",
            "exchange": "NSE", "side": "LONG", "optionType": None, "strike": None,
            "expiry": None, "signalType": "DIRECTIONAL", "entryMode": "CMP",
            "entryLow": None, "entryHigh": None, "slMode": "NONE", "stopLoss": None,
            "targets": [], "horizon": "SWING", "confidence": 0.7,
        }
    monkeypatch.setattr(svc, "_call_llm", fake_llm)
    out = asyncio.run(svc.parse_signal("Sgmart — a perfect breakout continuation pattern"))
    assert out["signalType"] == "DIRECTIONAL"
    assert out["targets"] == []


def test_rejects_out_of_domain_values(monkeypatch):
    async def fake_llm(_text):
        return {"isSignal": True, "symbol": "X", "instrument": "CRYPTO",  # invalid
                "side": "LONG", "signalType": "LEVELED", "entryMode": "CMP",
                "slMode": "NONE", "targets": [], "horizon": "INTRADAY", "confidence": 0.5}
    monkeypatch.setattr(svc, "_call_llm", fake_llm)
    out = asyncio.run(svc.parse_signal("whatever"))
    assert out["isSignal"] is False  # invalid instrument → coerced to not-a-signal
