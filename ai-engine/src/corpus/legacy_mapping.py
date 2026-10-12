"""Pure mapping: one legacy silo row (entry columns + joined trade columns prefixed ``t_``) → corpus Record.

Row shapes are produced by ``importer.SOURCE_QUERIES`` (TD_Automation and GrW-prod silo tables share
these column names). Mappers never touch a database; anything unusable raises ``Skip(reason)`` so the
importer can count it. Post-decision columns never enter ``evidence`` or ``features``.

Outcome JSON uses the spec's camelCase keys (§5.1): grossPnl, fees, netPnl, win, rMultiple, rDerived,
mfe, mae, holdMins.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any

from src.scorer import features_fs1, labels

IST = timezone(timedelta(hours=5, minutes=30))

KIND_ENTRY = "ENTRY_SETUP"
STRATEGY_KEYS = {"gated": "legacy.gated", "ungated": "legacy.ungated", "adaptive": "legacy.adaptive"}
CLOSED_WATCH_STATUSES = frozenset({"TARGET_HIT", "STOPPED", "EXITED"})
SKIPPED_WATCH_STATUSES = frozenset({"MISSED", "DISMISSED"})

# Entry-time columns copied into evidence (plus the strategy-specific extras below).
_EVIDENCE_COLUMNS = (
    "id", "alertId", "setupId", "symbol", "exchange", "side", "initialPrice", "initialScore",
    "initialBreakdown", "initialAt", "profitTarget", "profitTargetSource", "stopLossScore",
    "recoveryReEntry", "optionsType", "optionsExpiry", "optionsStrike", "optionsLotSize",
    "optionsSelectionScore", "riskAmount", "atrAtEntry", "stopPct", "stopPrice", "stopBasis",
    "gateSkipped", "gateReason", "gateDetail",
)
# Entry-time trade columns (gated `trades` M5 entry-context capture).
_EVIDENCE_TRADE_COLUMNS = ("t_vixAtEntry", "t_vixRegimeAtEntry", "t_adRatioAtEntry", "t_pcrAtEntry")


@dataclass
class Record:
    source: str
    source_id: str
    kind: str
    decided_at: datetime
    symbol: str
    exchange: str | None
    instrument_type: str | None
    direction: str | None
    vehicle: str | None
    strategy_key: str
    setup_group_key: str
    evidence: dict
    feature_set: str
    features: dict
    rule_score: float | None
    decision: dict
    outcome: dict | None
    outcome_at: datetime | None


class Skip(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


# ---------------------------------------------------------------- helpers

def _utc(v: Any) -> datetime | None:
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)  # Prisma timestamp(3) columns hold UTC
    if isinstance(v, str):
        try:
            d = datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError:
            return None
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    return None


def _jsonable(v: Any) -> Any:
    if isinstance(v, datetime):
        return _utc(v).isoformat()
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, float) and not math.isfinite(v):
        return None
    if isinstance(v, dict):
        return {k: _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    if hasattr(v, "__float__") and not isinstance(v, (int, float, bool)):
        return float(v)  # Decimal
    return v


def _float(v: Any) -> float | None:
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _direction(side: Any) -> str | None:
    s = str(side or "").upper()
    return "LONG" if s == "BUY" else "SHORT" if s == "SELL" else None


def _breakdown(row: dict) -> dict:
    bd = row.get("initialBreakdown")
    if isinstance(bd, str):
        import json
        try:
            bd = json.loads(bd)
        except ValueError:
            bd = None
    if not isinstance(bd, dict) or not isinstance(bd.get("checks"), list) or not bd["checks"]:
        raise Skip("no-breakdown")
    return bd


def _decided_at(row: dict) -> datetime:
    at = _utc(row.get("initialAt"))
    if at is None:
        raise Skip("no-decided-at")
    return at


def setup_group_key(row: dict, decided_at: datetime) -> str:
    return f"{row.get('alertId') or 'noalert'}|{row.get('symbol')}|{decided_at.astimezone(IST).date().isoformat()}"


def _evidence(row: dict) -> dict:
    ev = {k: _jsonable(row[k]) for k in _EVIDENCE_COLUMNS if k in row and row[k] is not None}
    for k in _EVIDENCE_TRADE_COLUMNS:
        if row.get(k) is not None:
            ev[k[2:]] = _jsonable(row[k])
    leaked = set(ev) & features_fs1.LEAKAGE_FIELDS
    if leaked:  # the column lists above are a fixed allow-list; this guards future edits
        raise ValueError(f"leakage in evidence: {sorted(leaked)}")
    return ev


def _context(row: dict, strategy: str, decided_at: datetime) -> dict:
    return {
        "decided_at": decided_at,
        "direction": _direction(row.get("side")),
        "strategy": strategy,
        "initial_price": _float(row.get("initialPrice")),
        "profit_target": _float(row.get("profitTarget")),
        "profit_target_source": row.get("profitTargetSource"),
        "vix_at_entry": _float(row.get("t_vixAtEntry")),
        "vix_regime": row.get("t_vixRegimeAtEntry"),
        "ad_ratio": _float(row.get("t_adRatioAtEntry")),
    }


def rule_score_from(features: dict) -> float | None:
    present = [k for k in features_fs1.CHECKS if features.get(f"{k}_missing") == 0]
    if not present:
        return None
    return sum(1 for k in present if features.get(f"{k}_passed") == 1) / len(present)


def _instrument(row: dict) -> tuple[str, str]:
    if row.get("optionsType"):
        return "OPTION", "option"
    return "EQUITY", "cash"


def _base(row: dict, source: str, strategy: str, table: str) -> dict:
    bd = _breakdown(row)
    decided_at = _decided_at(row)
    price = _float(row.get("initialPrice"))
    if price is None or price <= 0:
        raise Skip("bad-price")
    if not row.get("symbol"):
        raise Skip("no-symbol")
    feats, _missing = features_fs1.extract(bd, _context(row, strategy, decided_at))
    instrument_type, vehicle = _instrument(row)
    return dict(
        source=source,
        source_id=f"{table}:{row['id']}",
        kind=KIND_ENTRY,
        decided_at=decided_at,
        symbol=str(row["symbol"]),
        exchange=row.get("exchange"),
        instrument_type=instrument_type,
        direction=_direction(row.get("side")),
        vehicle=vehicle,
        strategy_key=STRATEGY_KEYS[strategy],
        setup_group_key=setup_group_key(row, decided_at),
        evidence=_evidence(row),
        feature_set=features_fs1.FEATURE_SET,
        features=feats,
        rule_score=rule_score_from(feats),
    )


def _outcome_json(o: labels.Outcome) -> dict:
    return {
        "grossPnl": o.gross_pnl, "fees": o.fees, "netPnl": o.net_pnl, "win": o.win,
        "rMultiple": o.r_multiple, "rDerived": o.r_derived, "mfe": o.mfe, "mae": o.mae,
        "holdMins": o.hold_mins,
    }


def _map_closed_trade(row: dict, source: str, strategy: str, table: str) -> Record:
    if str(row.get("t_status") or "").upper() != "CLOSED" or row.get("t_id") is None:
        raise Skip("not-closed")
    base = _base(row, source, strategy, table)
    entry_price = _float(row.get("t_entryPrice"))
    qty = _float(row.get("t_quantity"))
    gross = _float(row.get("t_pnl"))
    if entry_price is None or entry_price <= 0 or not qty:
        raise Skip("bad-price")
    if gross is None:
        raise Skip("no-pnl")
    entered_at = _utc(row.get("t_entryTime")) or _utc(row.get("executedAt")) or base["decided_at"]
    exited_at = _utc(row.get("t_exitTime")) or _utc(row.get("closedAt"))
    outcome = labels.label(
        gross_pnl=gross, fees=_float(row.get("t_fees")), entry_price=entry_price, qty=qty,
        entered_at=entered_at, exited_at=exited_at, stop_price=_float(row.get("t_stoploss")),
        risk_amount=_float(row.get("riskAmount")), mfe=_float(row.get("maxFavorable")),
        mae=_float(row.get("maxAdverse")),
    )
    return Record(**base, decision={"taken": True, "reason": f"{strategy}-executed"},
                  outcome=_outcome_json(outcome), outcome_at=exited_at)


# ---------------------------------------------------------------- mappers

def map_gated_trade(row: dict, source: str) -> Record:
    return _map_closed_trade(row, source, "gated", "watch_entries")


def map_gated_missed(row: dict, source: str) -> Record:
    """MISSED / DISMISSED gated entries: a skipped setup. Outcome is excursion-only (no P&L, win None).

    Watch status wins over any linked paper trade: TD_Automation re-labelled some executed-then-voided
    entries as MISSED ("missed-untraded") precisely to keep them out of realised P&L.
    """
    status = str(row.get("status") or "").upper()
    if status not in SKIPPED_WATCH_STATUSES:
        raise Skip("not-skipped")
    base = _base(row, source, "gated", "watch_entries")
    outcome = {
        "grossPnl": None, "fees": None, "netPnl": None, "win": None, "rMultiple": None, "rDerived": None,
        "mfe": _float(row.get("maxFavorable")), "mae": _float(row.get("maxAdverse")), "holdMins": None,
    }
    outcome_at = _utc(row.get("closedAt")) or _utc(row.get("dismissedAt"))
    return Record(**base, decision={"taken": False, "reason": status.lower()}, outcome=outcome,
                  outcome_at=outcome_at)


def map_ungated_trade(row: dict, source: str) -> Record:
    return _map_closed_trade(row, source, "ungated", "ungated_watch_entries")


def map_adaptive_trade(row: dict, source: str) -> Record:
    return _map_closed_trade(row, source, "adaptive", "adaptive_stop_watch_entries")


def map_row(table_key: str, row: dict, source: str) -> Record:
    """Dispatch a row of ``SOURCE_QUERIES[table_key]`` to its mapper."""
    if table_key == "gated":
        if str(row.get("status") or "").upper() in SKIPPED_WATCH_STATUSES:
            return map_gated_missed(row, source)
        return map_gated_trade(row, source)
    if table_key == "ungated":
        return map_ungated_trade(row, source)
    if table_key == "adaptive":
        return map_adaptive_trade(row, source)
    raise ValueError(f"unknown legacy table key: {table_key}")
