"""Derive sentinel corpus records from the gateway audit (``ai_calls``), no sentinel code change (spec §5.2).

One record per successful ``sentinel.judge`` / ``sentinel.overnight`` call, ``sourceId = ai_calls.id``
(idempotent). The context packet is the request's user message (``JSON.stringify(packet)``); the
parsed verdict comes from the ``sentinel_verdicts`` row written for the same evaluation.

Matching a call to its verdict row: the packet carries no tracker id, so candidates are verdicts
created within ±60 s of the call (same user when the call has one). Among them, the first rule that
matches wins: ``trackerId == ai_calls.positionId`` (when the gateway recorded a position id), else
a verdict whose stored ``packet`` equals the request packet; the nearest ``createdAt`` breaks ties.
No match → ``decision.verdict = None`` (counted ``verdict:unmatched``), the record is still written.

``sentinel.thesis`` and any other job are not review decisions and are skipped with a counted reason.
Outcome is left null here; it is filled when the watched position closes.
"""
from __future__ import annotations

import json
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any

from src.corpus.importer import upsert
from src.corpus.legacy_mapping import Record

SOURCE = "sentinel"
JOB_KINDS = {"sentinel.judge": "POSITION_REVIEW", "sentinel.overnight": "OVERNIGHT_REVIEW"}
MATCH_WINDOW = timedelta(seconds=60)

CALLS_SQL = (
    'SELECT "id", "job", "userId", "positionId", "request", "response", "createdAt" FROM "ai_calls" '
    "WHERE \"job\" LIKE 'sentinel.%' AND \"response\" IS NOT NULL ORDER BY \"createdAt\", \"id\""
)
VERDICTS_SQL = (
    'SELECT "id", "userId", "trackerId", "symbol", "verdict", "confidence", "thesisStatus", '
    '"recoveryAvailable", "reason", "invalidationPoint", "reviewInSec", "triggeredBy", "packet", "createdAt" '
    'FROM "sentinel_verdicts" WHERE "createdAt" BETWEEN %(lo)s AND %(hi)s '
    'AND (%(userId)s::text IS NULL OR "userId" = %(userId)s::text) ORDER BY "createdAt", "id"'
)


def _json(v: Any) -> Any:
    if isinstance(v, str):
        try:
            return json.loads(v)
        except ValueError:
            return None
    return v


def _utc(d: datetime) -> datetime:
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def packet_from_request(request: Any) -> dict | None:
    req = _json(request)
    if not isinstance(req, dict):
        return None
    for msg in req.get("messages") or []:
        if not isinstance(msg, dict) or msg.get("role") != "user":
            continue
        content = msg.get("content")
        if isinstance(content, list):
            content = "".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
        packet = _json(content)
        if isinstance(packet, dict):
            return packet
    return None


def _response_text(response: Any) -> str | None:
    resp = _json(response)
    if not isinstance(resp, dict):
        return None
    parts = [b.get("text", "") for b in resp.get("content") or [] if isinstance(b, dict) and b.get("type") == "text"]
    return "".join(parts) or None


def match_verdict(call: dict, packet: dict, candidates: list[dict]) -> dict | None:
    at = _utc(call["createdAt"])

    def nearest(rows: list[dict]) -> dict | None:
        return min(rows, key=lambda v: (abs((_utc(v["createdAt"]) - at).total_seconds()), str(v["id"])), default=None)

    if call.get("positionId"):
        hit = nearest([v for v in candidates if v.get("trackerId") == call["positionId"]])
        if hit:
            return hit
    return nearest([v for v in candidates if _json(v.get("packet")) == packet])


def build_record(call: dict, packet: dict, verdict: dict | None) -> Record:
    position = packet.get("position") if isinstance(packet.get("position"), dict) else {}
    side = str(position.get("side") or "").upper()
    tracker = verdict.get("trackerId") if verdict else call.get("positionId")
    if verdict:
        decision = {
            "verdict": verdict.get("verdict"), "confidence": verdict.get("confidence"),
            "thesisStatus": verdict.get("thesisStatus"), "recoveryAvailable": verdict.get("recoveryAvailable"),
            "reason": verdict.get("reason"), "invalidationPoint": verdict.get("invalidationPoint"),
            "reviewInSec": verdict.get("reviewInSec"), "triggeredBy": _json(verdict.get("triggeredBy")),
            "verdictId": verdict.get("id"),
        }
    else:
        decision = {"verdict": None, "raw": _response_text(call.get("response"))}
    return Record(
        source=SOURCE,
        source_id=str(call["id"]),
        kind=JOB_KINDS[call["job"]],
        decided_at=_utc(call["createdAt"]),
        symbol=str(position.get("symbol") or (verdict or {}).get("symbol") or "UNKNOWN"),
        exchange=None,
        instrument_type=position.get("segment"),
        direction="LONG" if side in ("BUY", "LONG") else "SHORT" if side in ("SELL", "SHORT") else None,
        vehicle=position.get("kind"),
        strategy_key="sentinel",
        setup_group_key=f"tracker:{tracker}" if tracker else f"call:{call['id']}",
        evidence=packet,
        feature_set=None,
        features=None,
        rule_score=None,
        decision=decision,
        outcome=None,
        outcome_at=None,
    )


def build_from_ai_calls(conn) -> dict[str, int]:
    """Upsert one record per successful sentinel review call; returns counts. Commits once."""
    counts: Counter[str] = Counter()
    try:
        with conn.cursor() as cur:
            cur.execute(CALLS_SQL)
            calls = cur.fetchall()
            for call in calls:
                kind = JOB_KINDS.get(call["job"])
                if kind is None:
                    counts[f"skip:job:{call['job']}"] += 1
                    continue
                packet = packet_from_request(call["request"])
                if packet is None:
                    counts["skip:no-packet"] += 1
                    continue
                at = _utc(call["createdAt"])
                cur.execute(VERDICTS_SQL, {"lo": at - MATCH_WINDOW, "hi": at + MATCH_WINDOW,
                                           "userId": call.get("userId")})
                verdict = match_verdict(call, packet, cur.fetchall())
                counts["verdict:matched" if verdict else "verdict:unmatched"] += 1
                rec = build_record(call, packet, verdict)
                counts["inserted" if upsert(cur, rec, [str(call["id"])]) else "updated"] += 1
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    counts.setdefault("inserted", 0)
    counts.setdefault("updated", 0)
    return dict(counts)
