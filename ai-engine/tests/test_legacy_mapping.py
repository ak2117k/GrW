import copy
import json
from pathlib import Path

import pytest

from src.corpus import legacy_mapping as lm
from src.scorer import features_fs1

FIX = Path(__file__).parent / "fixtures" / "legacy"
SRC = "legacy:td_automation"


def _rows(name):
    return json.loads((FIX / f"{name}.json").read_text(encoding="utf-8"))


def _closed(rows, with_checks=False):
    out = [r for r in rows if r["t_status"] == "CLOSED" and r["status"] not in ("MISSED", "DISMISSED")]
    return [r for r in out if (r["initialBreakdown"] or {}).get("checks")] if with_checks else out


@pytest.mark.parametrize("table,mapper,strategy", [
    ("gated", lm.map_gated_trade, "legacy.gated"),
    ("ungated", lm.map_ungated_trade, "legacy.ungated"),
    ("adaptive", lm.map_adaptive_trade, "legacy.adaptive"),
])
def test_closed_trades_map_to_taken_entry_setups(table, mapper, strategy):
    rows = _closed(_rows(table))
    assert rows
    for row in rows:
        if not (row["initialBreakdown"] or {}).get("checks"):
            # real legacy rows: 184 ungated entries carry an empty {} breakdown (Review Focus 4)
            with pytest.raises(lm.Skip, match="no-breakdown"):
                mapper(row, SRC)
            continue
        rec = mapper(row, SRC)
        assert rec.kind == "ENTRY_SETUP"
        assert rec.strategy_key == strategy
        assert rec.source == SRC
        assert rec.decision["taken"] is True
        assert rec.direction == ("LONG" if row["side"] == "BUY" else "SHORT")
        ist_date = rec.decided_at.astimezone(lm.IST).date().isoformat()
        assert rec.setup_group_key == f"{row['alertId'] or 'noalert'}|{row['symbol']}|{ist_date}"
        assert rec.feature_set == features_fs1.FEATURE_SET
        assert list(rec.features) == features_fs1.feature_names()
        assert isinstance(rec.outcome["win"], bool)
        assert rec.outcome["netPnl"] == pytest.approx(rec.outcome["grossPnl"] - rec.outcome["fees"])
        assert 0.0 <= rec.rule_score <= 1.0
        json.dumps(rec.evidence)  # JSON-serialisable


def test_no_leakage_key_in_evidence():
    for table in ("gated", "ungated", "adaptive"):
        for row in _rows(table):
            try:
                rec = lm.map_row(table, row, SRC)
            except lm.Skip:
                continue
            assert not (set(rec.evidence) & features_fs1.LEAKAGE_FIELDS)
            assert "maxFavorable" not in rec.evidence and "status" not in rec.evidence
            assert not any(k.startswith("current") for k in rec.evidence)


def test_real_empty_breakdown_fixture_present():
    assert any(r["initialBreakdown"] == {} for r in _rows("ungated"))


@pytest.mark.parametrize("bd", [None, {}, {"checks": []}, "not json", {"checks": None}])
def test_null_breakdown_is_counted_skip(bd):
    row = copy.deepcopy(_closed(_rows("gated"))[0])
    row["initialBreakdown"] = bd
    with pytest.raises(lm.Skip) as e:
        lm.map_gated_trade(row, SRC)
    assert e.value.reason == "no-breakdown"


def test_open_trade_is_not_closed_skip():
    watching = [r for r in _rows("ungated") if r["status"] == "WATCHING"][0]
    with pytest.raises(lm.Skip) as e:
        lm.map_ungated_trade(watching, SRC)
    assert e.value.reason == "not-closed"
    row = copy.deepcopy(_closed(_rows("adaptive"))[0])
    row["t_status"] = "OPEN"
    with pytest.raises(lm.Skip) as e:
        lm.map_adaptive_trade(row, SRC)
    assert e.value.reason == "not-closed"


def test_traded_status_with_closed_trade_is_taken():
    row = [r for r in _rows("adaptive") if r["status"] == "TRADED"][0]
    assert lm.map_adaptive_trade(row, SRC).decision["taken"] is True


def test_missed_and_dismissed_are_skipped_setups_with_excursions():
    for status in ("MISSED", "DISMISSED"):
        row = [r for r in _rows("gated") if r["status"] == status][0]
        rec = lm.map_row("gated", row, SRC)
        assert rec.decision == {"taken": False, "reason": status.lower()}
        assert rec.outcome["win"] is None
        assert rec.outcome["mfe"] == row["maxFavorable"] and rec.outcome["mae"] == row["maxAdverse"]


def test_missed_with_linked_trade_still_skipped():
    row = copy.deepcopy([r for r in _rows("gated") if r["status"] == "MISSED"][0])
    closed = _closed(_rows("gated"))[0]
    row.update({k: v for k, v in closed.items() if k.startswith("t_")})
    assert lm.map_row("gated", row, SRC).decision["taken"] is False


def test_bad_price_and_missing_pnl_skips():
    row = copy.deepcopy(_closed(_rows("ungated"), with_checks=True)[0])
    row["initialPrice"] = 0
    with pytest.raises(lm.Skip) as e:
        lm.map_ungated_trade(row, SRC)
    assert e.value.reason == "bad-price"
    row = copy.deepcopy(_closed(_rows("ungated"), with_checks=True)[0])
    row["t_pnl"] = None
    with pytest.raises(lm.Skip) as e:
        lm.map_ungated_trade(row, SRC)
    assert e.value.reason == "no-pnl"


def test_unknown_check_name_does_not_crash():
    row = copy.deepcopy(_closed(_rows("gated"))[0])
    row["initialBreakdown"]["checks"].append({"name": "Brand new check", "passed": True, "detail": {"x": 1}})
    rec = lm.map_gated_trade(row, SRC)
    assert list(rec.features) == features_fs1.feature_names()


def test_adaptive_uses_stored_risk():
    row = _closed(_rows("adaptive"))[0]
    rec = lm.map_adaptive_trade(row, SRC)
    assert rec.outcome["rDerived"] is False
    assert rec.evidence["riskAmount"] == row["riskAmount"]


def test_source_id_namespaced_by_table():
    row = _closed(_rows("gated"))[0]
    assert lm.map_gated_trade(row, SRC).source_id == f"watch_entries:{row['id']}"
