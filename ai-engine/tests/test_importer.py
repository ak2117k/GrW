import json
from pathlib import Path

import pytest

from src.corpus import importer
from tests.fakes import FakeConn

FIX = Path(__file__).parent / "fixtures" / "legacy"


def _src():
    return FakeConn(tables={
        "watch_entries": json.loads((FIX / "gated.json").read_text(encoding="utf-8")),
        "ungated_watch_entries": json.loads((FIX / "ungated.json").read_text(encoding="utf-8")),
        "adaptive_stop_watch_entries": json.loads((FIX / "adaptive.json").read_text(encoding="utf-8")),
    })


TABLES = ["gated", "ungated", "adaptive"]


def test_excluded_tables_not_queried():
    joined = " ".join(importer.SOURCE_QUERIES.values()).lower()
    for excluded in ("sell_futures", "intraday_entries", "swing_entries", "breakout_swing_entries",
                     "ungated_rejections", '"signals"'):
        assert excluded not in joined
    assert not any("sell_futures" in k for k in importer.SOURCE_QUERIES)
    with pytest.raises(ValueError):
        importer.import_source(_src(), None, "td_automation", ["sell_futures"])


def test_queries_are_select_only():
    for q in importer.SOURCE_QUERIES.values():
        assert q.lstrip().upper().startswith("SELECT")
        for verb in ("INSERT", "UPDATE ", "DELETE", "DROP", "ALTER"):
            assert verb not in q.upper()


def test_dry_run_counts_with_skip_reasons():
    counts = importer.import_source(_src(), None, "td_automation", TABLES)
    assert "inserted" not in counts
    assert counts["skip:no-breakdown"] >= 1
    assert counts["skip:not-closed"] >= 1
    assert counts["taken"] >= 1 and counts["skipped_setups"] == 2
    total_rows = sum(v for k, v in counts.items() if k.startswith("rows:"))
    skips = sum(v for k, v in counts.items() if k.startswith("skip:"))
    assert counts["mapped"] + skips == total_rows


def test_second_run_updates_not_inserts():
    dst = FakeConn()
    first = importer.import_source(_src(), dst, "td_automation", TABLES)
    assert first["inserted"] == first["mapped"] and first["updated"] == 0
    ids = {k: v["id"] for k, v in dst.records.items()}
    second = importer.import_source(_src(), dst, "td_automation", TABLES)
    assert second["inserted"] == 0 and second["updated"] == first["mapped"]
    assert {k: v["id"] for k, v in dst.records.items()} == ids
    assert dst.commits == 2
    assert all(k[0] == "legacy:td_automation" for k in dst.records)


def test_upsert_sql_conflict_target_and_outcome_preservation():
    sql = importer.UPSERT_SQL
    assert 'ON CONFLICT ("source", "sourceId") DO UPDATE' in sql
    assert 'COALESCE(EXCLUDED."outcome"' in sql
    assert 'RETURNING ("xmax" = 0)' in sql


def test_params_are_json_strings():
    dst = FakeConn()
    importer.import_source(_src(), dst, "td_automation", ["adaptive"])
    row = next(iter(dst.records.values()))
    for col in ("evidence", "features", "decision", "outcome"):
        assert isinstance(row[col], str)
        json.loads(row[col])
    assert row["aiCallIds"] == []


def test_db_error_rolls_back():
    class Boom(FakeConn):
        def cursor(self):
            raise RuntimeError("db down")
    dst = Boom()
    with pytest.raises(RuntimeError):
        importer.import_source(_src(), dst, "td_automation", ["adaptive"])
    assert dst.rollbacks == 1 and dst.commits == 0
