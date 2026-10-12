"""Idempotent legacy importer: silo tables → ``ai_decision_records`` (upsert by ``source, sourceId``).

Reads with SELECT only. Writes only ``ai_decision_records`` (Python never runs migrations).
Excluded by design (spec §5.2): ``sell_futures_*``, anand tables, ``ungated_rejections``, ``signals``.
"""
from __future__ import annotations

import json
import uuid
from collections import Counter
from typing import Any

from src.corpus.legacy_mapping import Record, Skip, map_row

SOURCES = {"td_automation": "legacy:td_automation", "grw_prod": "legacy:grw_prod"}

_ENTRY_COLS = (
    "id", "alertId", "setupId", "symbol", "exchange", "side", "initialPrice", "initialScore",
    "initialBreakdown", "initialAt", "profitTarget", "profitTargetSource", "stopLossScore",
    "executedAt", "closedAt", "dismissedAt", "maxFavorable", "maxAdverse",
)
_TRADE_COLS = ("id", "status", "pnl", "fees", "entryPrice", "quantity", "stoploss", "entryTime", "exitTime")
_GATED_EXTRA = ("recoveryReEntry", "optionsType", "optionsExpiry", "optionsStrike", "optionsLotSize",
                "optionsSelectionScore")
_GATED_TRADE_EXTRA = ("vixAtEntry", "vixRegimeAtEntry", "adRatioAtEntry", "pcrAtEntry")
_ADAPTIVE_EXTRA = ("riskAmount", "atrAtEntry", "stopPct", "stopPrice", "stopBasis", "gateSkipped",
                   "gateReason", "gateDetail")


def _select(entry_table: str, trade_table: str, entry_extra: tuple = (), trade_extra: tuple = ()) -> str:
    cols = [f'w."{c}"' for c in _ENTRY_COLS + entry_extra] + ['w."status"::text AS "status"']
    cols += [f't."{c}" AS "t_{c}"' for c in _TRADE_COLS + trade_extra]
    return (f'SELECT {", ".join(cols)} FROM "{entry_table}" w '
            f'LEFT JOIN "{trade_table}" t ON t."id" = w."paperTradeId" ORDER BY w."initialAt", w."id"')


SOURCE_QUERIES: dict[str, str] = {
    "gated": _select("watch_entries", "trades", _GATED_EXTRA, _GATED_TRADE_EXTRA),
    "ungated": _select("ungated_watch_entries", "ungated_trades"),
    "adaptive": _select("adaptive_stop_watch_entries", "adaptive_stop_trades", _ADAPTIVE_EXTRA),
}

UPSERT_SQL = """
INSERT INTO "ai_decision_records" (
  "id", "source", "sourceId", "kind", "decidedAt", "symbol", "exchange", "instrumentType", "direction",
  "vehicle", "strategyKey", "setupGroupKey", "evidence", "featureSet", "features", "ruleScore",
  "decision", "aiCallIds", "outcome", "outcomeAt"
) VALUES (
  %(id)s, %(source)s, %(sourceId)s, %(kind)s, %(decidedAt)s, %(symbol)s, %(exchange)s, %(instrumentType)s,
  %(direction)s, %(vehicle)s, %(strategyKey)s, %(setupGroupKey)s, %(evidence)s::jsonb, %(featureSet)s,
  %(features)s::jsonb, %(ruleScore)s, %(decision)s::jsonb, %(aiCallIds)s, %(outcome)s::jsonb, %(outcomeAt)s
)
ON CONFLICT ("source", "sourceId") DO UPDATE SET
  -- never erase an outcome another job already filled in (sentinel outcomes arrive later)
  "outcome" = COALESCE(EXCLUDED."outcome", "ai_decision_records"."outcome"),
  "outcomeAt" = COALESCE(EXCLUDED."outcomeAt", "ai_decision_records"."outcomeAt"),
  "evidence" = EXCLUDED."evidence", "features" = EXCLUDED."features", "featureSet" = EXCLUDED."featureSet",
  "ruleScore" = EXCLUDED."ruleScore", "decision" = EXCLUDED."decision"
RETURNING ("xmax" = 0) AS "inserted"
"""


def _dumps(v: Any) -> str | None:
    return None if v is None else json.dumps(v, allow_nan=False, default=str)


def record_params(rec: Record, ai_call_ids: list[str] | None = None) -> dict:
    """Record (snake) → upsert parameters (camel column names)."""
    return {
        "id": uuid.uuid4().hex,
        "source": rec.source,
        "sourceId": rec.source_id,
        "kind": rec.kind,
        "decidedAt": rec.decided_at,
        "symbol": rec.symbol,
        "exchange": rec.exchange,
        "instrumentType": rec.instrument_type,
        "direction": rec.direction,
        "vehicle": rec.vehicle,
        "strategyKey": rec.strategy_key,
        "setupGroupKey": rec.setup_group_key,
        "evidence": _dumps(rec.evidence),
        "featureSet": rec.feature_set,
        "features": _dumps(rec.features),
        "ruleScore": rec.rule_score,
        "decision": _dumps(rec.decision),
        "aiCallIds": list(ai_call_ids or []),
        "outcome": _dumps(rec.outcome),
        "outcomeAt": rec.outcome_at,
    }


def upsert(cur, rec: Record, ai_call_ids: list[str] | None = None) -> bool:
    """Upsert one record; True when inserted, False when an existing row was updated."""
    cur.execute(UPSERT_SQL, record_params(rec, ai_call_ids))
    row = cur.fetchone()
    return bool(row["inserted"] if isinstance(row, dict) else row[0])


def import_source(src_conn, dst_conn, source: str, tables: list[str]) -> dict[str, int]:
    """Map every row of ``tables`` from ``src_conn``; upsert into ``dst_conn`` (None = dry run).

    ``source`` is a key of ``SOURCES`` (or an already-prefixed ``legacy:*`` value).
    Returns counts ``{"inserted", "updated", "mapped", "taken", "skipped_setups", "skip:<reason>"...}``.
    Commits once at the end; rolls back and re-raises on any database error.
    """
    source_value = SOURCES.get(source, source)
    counts: Counter[str] = Counter()
    records: list[Record] = []
    for table in tables:
        if table not in SOURCE_QUERIES:
            raise ValueError(f"unknown/excluded legacy table: {table}")
        with src_conn.cursor() as cur:
            cur.execute(SOURCE_QUERIES[table])
            rows = cur.fetchall()
        for row in rows:
            counts[f"rows:{table}"] += 1
            try:
                rec = map_row(table, row, source_value)
            except Skip as s:
                counts[f"skip:{s.reason}"] += 1
                continue
            records.append(rec)
            counts["mapped"] += 1
            counts["taken" if rec.decision.get("taken") else "skipped_setups"] += 1

    if dst_conn is None:
        return dict(counts)

    try:
        with dst_conn.cursor() as cur:
            for rec in records:
                counts["inserted" if upsert(cur, rec) else "updated"] += 1
        dst_conn.commit()
    except Exception:
        dst_conn.rollback()
        raise
    counts.setdefault("inserted", 0)
    counts.setdefault("updated", 0)
    return dict(counts)
