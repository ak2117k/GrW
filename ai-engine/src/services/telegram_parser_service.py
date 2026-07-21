"""Parse free-text Telegram trade signals into a structured contract via Claude.

LLM backend is the **Claude Agent SDK** (``claude-agent-sdk``), authenticated by
the host's Claude subscription login (Claude Code / ``claude`` login) — there is
NO ``ANTHROPIC_API_KEY``. This keeps local R&D on the existing Max plan at ₹0.

``_call_llm`` is the single swappable seam: a raw ``anthropic`` Messages-API
backend (keyed by ``ANTHROPIC_API_KEY`` + ``claude-haiku-4-5``) can be dropped in
for always-on production without touching ``parse_signal``/``_normalize``. The
golden-set tests monkeypatch ``_call_llm``, so they run offline with no login.
"""

import json
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

_SCHEMA_HINT = (
    'Return ONLY a JSON object, no prose, with these keys: '
    'isSignal(bool), symbol(str), instrument(one of EQUITY|OPTION|FUTURE|INDEX), '
    'exchange(str|null), side(LONG|SHORT), optionType(CE|PE|null), strike(number|null), '
    'expiry(str|null), signalType(LEVELED|DIRECTIONAL), '
    'entryMode(CMP|ZONE|TRIGGER_ABOVE|TRIGGER_BELOW|NEAR), entryLow(number|null), '
    'entryHigh(number|null), slMode(NUMERIC|PREMIUM_PAID|NONE), stopLoss(number|null), '
    'targets(array of numbers), horizon(INTRADAY|SWING), confidence(0..1 number).'
)

_NOT_A_SIGNAL = {
    "isSignal": False, "symbol": "", "instrument": "EQUITY", "exchange": None,
    "side": "LONG", "optionType": None, "strike": None, "expiry": None,
    "signalType": "DIRECTIONAL", "entryMode": "CMP", "entryLow": None,
    "entryHigh": None, "slMode": "NONE", "stopLoss": None, "targets": [],
    "horizon": "INTRADAY", "confidence": 0.0,
}


async def _call_llm(text: str) -> Dict[str, Any]:
    """Extract a structured signal via the Claude Agent SDK. Patched in tests.

    Uses ``claude_agent_sdk.query`` (async iterator of messages). The assistant's
    text lives in ``AssistantMessage.content`` as ``TextBlock`` items; we
    concatenate those, strip an optional ```` ```json ```` fence, and ``json.loads``
    the result. The SDK is imported lazily so tests (which patch this function)
    never require the package or a login to be present.

    API verified against https://code.claude.com/docs/en/agent-sdk/python
    (claude-agent-sdk 0.2.124): ``query(*, prompt, options)`` is an async iterator;
    ``ClaudeAgentOptions(system_prompt=..., max_turns=..., allowed_tools=...)``;
    text is read from ``AssistantMessage.content`` -> ``TextBlock.text``.
    """
    from claude_agent_sdk import (  # lazy: tests patch _call_llm, never import
        query,
        ClaudeAgentOptions,
        AssistantMessage,
        TextBlock,
    )

    options = ClaudeAgentOptions(
        system_prompt=f"{_SYSTEM}\n\n{_SCHEMA_HINT}",
        max_turns=1,
        allowed_tools=[],  # pure text completion — no tools, no permission prompts
    )
    chunks: list[str] = []
    async for message in query(prompt=text, options=options):
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    chunks.append(block.text)
    raw = "".join(chunks).strip()
    # Strip a ```json ... ``` fence if the model wrapped its answer.
    if raw.startswith("```"):
        raw = raw.split("```", 2)[1]
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.strip()
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
    """Parse ``text`` into the structured signal contract (validated/normalized)."""
    if not text or not text.strip():
        return dict(_NOT_A_SIGNAL)
    raw = await _call_llm(text)
    return _normalize(raw)
