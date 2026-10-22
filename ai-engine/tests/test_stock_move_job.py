"""Stock-move nightly job: book (rank + bucket), outcome fill, Yahoo cache, NSE calendar, the end-to-end run
on the parity fixture with a FakeRepo, the schedule, and the ship script's registry SQL. No network, no DB."""
from __future__ import annotations

import importlib.util
import json
from datetime import date, datetime
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
import pytest

from src.mbm.service import clock
from src.mbm.stock_move import calendar as C
from src.mbm.stock_move import nse as N
from src.mbm.stock_move import prices as P
from src.mbm.stock_move.job import StockMoveJob, dry_run, mode_from, outcome_rows
from src.mbm.stock_move.model import StockMoveModel, book, design
from src.mbm.stock_move.panel import build_panel, frame_reader
from tests.test_stock_move_features import CUTOFF, SYMS, load_calendar, load_prices, sectors

IST = clock.IST


def ist(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=IST)


# ── book ───────────────────────────────────────────────────────────────────────

def test_book_ranks_and_buckets_top_and_bottom_fifths():
    raw = np.array([0.10, 0.50, 0.20, 0.90, 0.30, 0.80, 0.40, 0.70, 0.60, 0.05])
    rank, b = book(raw)
    assert rank.max() == 1.0 and rank.min() == pytest.approx(0.1)
    assert [b[i] for i in np.argsort(-raw)[:2]] == ["TOP20", "TOP20"]
    assert [b[i] for i in np.argsort(raw)[:2]] == ["BOTTOM20", "BOTTOM20"]
    assert b.count("MID") == 6


def test_book_ties_share_a_rank_and_empty_is_empty():
    rank, b = book(np.array([0.5, 0.5, 0.5, 0.5]))
    assert set(rank) == {0.625} and set(b) == {"MID"}
    assert book(np.array([]))[1] == []


# ── outcome fill ───────────────────────────────────────────────────────────────

def _px(closes, start="2026-09-21"):   # 09-21 .. 10-01: no NSE holiday inside
    d = pd.bdate_range(start, periods=len(closes))
    return pd.DataFrame({"date": d, "open": closes, "high": closes, "low": closes, "close": closes, "volume": 1.0})


def test_outcome_is_the_training_label_and_waits_for_five_sessions():
    d = _px([100, 101, 99, 102, 104, 106.5, 107, 90, 91])
    read = {"AAA": d}.get
    pend = [{"id": 1, "as_of": date(2026, 9, 21), "symbol": "AAA", "close": 100, "atr_pct": 0.01},
            {"id": 2, "as_of": date(2026, 9, 22), "symbol": "AAA", "close": 101, "atr_pct": 0.05},
            {"id": 3, "as_of": date(2026, 9, 29), "symbol": "AAA", "close": 107, "atr_pct": 0.01}]
    out = {r["id"]: r for r in outcome_rows(pend, read, ist("2026-10-01T20:30"))}
    # +6.5% over 5 sessions vs 1.5 x 1% x sqrt5 = 3.35% -> big
    assert out[1]["big"] is True and out[1]["ret_bp"] == pytest.approx(650.0)
    # row 2: |107/101 - 1| = 5.9% < 1.5 x 5% x sqrt5 = 16.8% -> not big
    assert out[2]["big"] is False
    assert 3 not in out          # only 2 sessions after 09-29: not ready


def test_outcome_window_counts_nse_sessions_across_holidays():
    """as_of 2026-10-15 (Thu): 16, 19, [20 Dussehra], 21, 22, 23 -> the window ends Fri 10-23, not 10-22."""
    dts = pd.to_datetime(["2026-10-15", "2026-10-16", "2026-10-19", "2026-10-21", "2026-10-22", "2026-10-23"])
    c = [100, 100, 100, 100, 100, 110]
    d = pd.DataFrame({"date": dts, "open": c, "high": c, "low": c, "close": c, "volume": 1.0})
    pend = [{"id": 1, "as_of": date(2026, 10, 15), "symbol": "AAA", "atr_pct": 0.01}]
    assert outcome_rows(pend, {"AAA": d.iloc[:5]}.get, ist("2026-10-22T20:30")) == []   # 10-22 is session 4
    out = outcome_rows(pend, {"AAA": d}.get, ist("2026-10-23T20:30"))
    assert out[0]["big"] is True and out[0]["ret_bp"] == pytest.approx(1000.0)
    from src.mbm.stock_move.sessions import SessionCalendar
    cal = SessionCalendar()
    assert cal.add_sessions(date(2026, 11, 6), 5) == date(2026, 11, 16)      # 11-10 Balipratipada skipped
    # inside the index's range its bars decide (a listed holiday NSE traded on, an unlisted closure)
    idx = pd.bdate_range("2026-10-12", "2026-10-23").drop(pd.Timestamp("2026-10-14"))
    cal = SessionCalendar(idx)
    assert cal.is_session(date(2026, 10, 20)) and not cal.is_session(date(2026, 10, 14))
    assert cal.add_sessions(date(2026, 10, 13), 1) == date(2026, 10, 15)


def test_outcome_across_a_corporate_action_jump_is_null_and_stale_rows_give_up():
    d = _px([100, 100, 40, 41, 42, 43])          # -60% overnight: an unadjusted split
    pend = [{"id": 1, "as_of": date(2026, 9, 21), "symbol": "AAA", "atr_pct": 0.01},
            {"id": 2, "as_of": date(2026, 8, 1), "symbol": "GONE", "atr_pct": 0.01},
            {"id": 3, "as_of": date(2026, 9, 25), "symbol": "GONE", "atr_pct": 0.01}]
    read = lambda s: d if s == "AAA" else pd.DataFrame(columns=P.COLS)  # noqa: E731
    out = {r["id"]: r for r in outcome_rows(pend, read, ist("2026-10-01T20:30"))}
    assert out[1]["big"] is None and out[1]["ret_bp"] is None
    assert out[2]["big"] is None and out[2]["at"] is not None      # > 30 days without data: closed
    assert 3 not in out


def test_outcome_fill_reproduces_the_research_label(tmp_path):
    exp = pd.read_csv(Path(__file__).parent / "fixtures" / "stock_move" / "expected_panel.csv.gz", parse_dates=["date"])
    exp = exp[exp["y_big5_1.5"].notna()]
    prices = load_prices()
    pend = [{"id": i, "as_of": r.date.date(), "symbol": r.sym, "atr_pct": r.atr_pct} for i, r in enumerate(exp.itertuples())]
    out = {r["id"]: r for r in outcome_rows(pend, prices.get, ist("2026-10-21T20:30"))}
    assert len(out) == len(exp)
    assert [out[i]["big"] for i in range(len(exp))] == [bool(v) for v in exp["y_big5_1.5"]]


# ── Yahoo cache ────────────────────────────────────────────────────────────────

def payload(df: pd.DataFrame) -> dict:
    ts = [int(pd.Timestamp(d).tz_localize(IST).timestamp()) + 9 * 3600 + 15 * 60 for d in df["date"]]
    return {"chart": {"result": [{"timestamp": ts, "indicators": {"quote": [{
        "open": df["open"].tolist(), "high": df["high"].tolist(), "low": df["low"].tolist(),
        "close": df["close"].tolist(), "volume": df["volume"].tolist()}]}}], "error": None}}


class FakeYahoo:
    """Serves fixture frames up to `until`, honouring range=10y / period1."""

    def __init__(self, frames, until):
        self.frames, self.until, self.calls, self.scale = frames, pd.Timestamp(until), [], {}

    def __call__(self, url, params):
        ysym = url.rsplit("/", 1)[1].replace("%26", "&")
        name = {v: k for k, v in P.INDEX_YAHOO.items()}.get(ysym, ysym.removesuffix(".NS"))
        self.calls.append((name, "period1" in params))
        d = self.frames[name]
        d = d[d.date <= self.until]
        if "period1" in params:
            d = d[d.date >= pd.Timestamp(datetime.fromtimestamp(params["period1"], IST).date())]
        d = d.copy()
        k = self.scale.get(name, 1.0)
        d[["open", "high", "low", "close"]] *= k
        return payload(d)


def test_yahoo_refresh_incremental_readjust_and_partial_bar(tmp_path):
    frames = load_prices()
    y = FakeYahoo(frames, "2026-10-09")
    cache = P.PriceCache(tmp_path)
    assert P.refresh_symbol(cache, "TCS", ist("2026-10-09T12:00"), get=y, sleep=lambda s: None) == "full"
    assert cache.read("TCS")["date"].max() == pd.Timestamp("2026-10-08")      # today's bar is not final yet
    y.until = pd.Timestamp("2026-10-16")
    assert P.refresh_symbol(cache, "TCS", ist("2026-10-16T20:15"), get=y, sleep=lambda s: None) == "incremental"
    got = cache.read("TCS")
    exp = frames["TCS"][frames["TCS"].date <= "2026-10-16"].reset_index(drop=True)
    pd.testing.assert_frame_equal(got, exp[P.COLS], check_dtype=False)
    y.scale["TCS"] = 0.5                                                      # a 1:2 split re-adjusts history
    assert P.refresh_symbol(cache, "TCS", ist("2026-10-16T20:15"), get=y, sleep=lambda s: None) == "readjusted"
    assert cache.read("TCS")["close"].iloc[0] == pytest.approx(exp["close"].iloc[0] * 0.5)


def test_yahoo_failures_are_counted_not_raised(tmp_path):
    def boom(url, params):
        raise RuntimeError("down")
    st = P.refresh_all(P.PriceCache(tmp_path), ["TCS", "ONGC"], ist("2026-10-16T20:15"), get=boom, sleep=lambda s: None)
    assert st["ok"] == 0 and st["failed"] == ["TCS", "ONGC"]
    assert P.yahoo_symbol("M&M") == "M&M.NS" and P.yahoo_symbol("NIFTYIDX") == "^NSEI"


# ── NSE calendar ───────────────────────────────────────────────────────────────

BM = [{"bm_symbol": "TCS", "bm_date": "09-Jan-2027", "bm_purpose": "Financial Results",
       "bm_desc": "To consider the results", "bm_timestamp": "20-Oct-2026 18:01:02"},
      {"bm_symbol": "TCS", "bm_date": "30-Oct-2026", "bm_purpose": "Fund Raising", "bm_desc": "NCDs",
       "bm_timestamp": "20-Oct-2026 18:01:02"},
      {"bm_symbol": "ZZZ", "bm_date": "05-Nov-2026", "bm_purpose": "Financial Results", "bm_desc": "",
       "bm_timestamp": "20-Oct-2026 18:01:02"}]
RES = [{"symbol": "ONGC", "broadCastDate": "20-Oct-2026 17:10:00", "toDate": "30-Sep-2026"},
       {"symbol": "ONGC", "broadCastDate": "20-Oct-2026 17:10:00", "toDate": "31-Mar-2025"}]   # old quarter re-filed


def test_nse_bulk_parse_keeps_universe_results_rows_only():
    R, B = N.parse_bulk(BM, RES, set(SYMS))
    assert B[["sym", "meet_date"]].values.tolist() == [["TCS", pd.Timestamp("2027-01-09")]]
    assert R[["sym", "t"]].values.tolist() == [["ONGC", pd.Timestamp("2026-10-20 17:10:00")]]


def test_calendar_cache_merges_seed_and_nightly_and_is_fail_soft(tmp_path):
    R0, B0 = load_calendar()
    seed = tmp_path / "seed"
    seed.mkdir()
    N.write_csv(R0, seed / "calendar_R.csv.gz")
    N.write_csv(B0, seed / "calendar_B.csv.gz")
    cal = N.CalendarCache(tmp_path / "cache", seed)
    assert N.refresh(cal, SYMS, ist("2026-10-20T20:15"), fetch=lambda now: (BM, RES))["ok"]
    assert N.refresh(cal, SYMS, ist("2026-10-20T20:15"), fetch=lambda now: (BM, RES))["ok"]   # idempotent
    R, B = cal.load()
    assert len(R) == len(R0) + 1 and len(B) == len(B0) + 1
    pd.testing.assert_frame_equal(R.iloc[:len(R0)].reset_index(drop=True), R0, check_dtype=False)

    def down(now):
        raise ConnectionError("nse down")
    r = N.refresh(cal, SYMS, ist("2026-10-21T20:15"), fetch=down)
    assert r["ok"] is False and "nse down" in r["error"]
    assert len(cal.load()[0]) == len(R)


# ── artefact + end-to-end run ──────────────────────────────────────────────────

def make_artifact(d: Path, version="20261019") -> Path:
    """A tiny model in the real artefact format (trained on the fixture panel)."""
    from src.mbm.stock_move import features as F
    R, B = load_calendar()
    p, _ = build_panel(SYMS, frame_reader(load_prices()), R, B, sectors(), CUTOFF)
    p = p[p["y_big5_1.0"].notna()]
    cols = F.feature_columns([c for c in p.columns if c != C.MEET_COL])
    cats = sorted(p["sector"].unique())
    X = design(p, cols, cats)
    bst = lgb.train({"objective": "binary", "num_leaves": 4, "min_data_in_leaf": 5, "verbose": -1, "seed": 1},
                    lgb.Dataset(X, p["y_big5_1.0"], categorical_feature=["sector"]), num_boost_round=5)
    out = d / "stock-move" / version
    out.mkdir(parents=True)
    bst.save_model(str(out / "model.txt"))
    meta = {"modelId": f"stock-move-{version}", "featureSet": "sm-daily-er0", "columns": cols,
            "sectorCategories": cats, "sectors": sectors(), "isotonic": {"x": [0.0, 1.0], "y": [0.0, 1.0]},
            "trainedThrough": "2026-10-19", "universe": SYMS}
    (out / "meta.json").write_text(json.dumps(meta))
    (out / "metrics.json").write_text("{}")
    N.write_csv(R, out / "calendar_R.csv.gz")
    N.write_csv(B, out / "calendar_B.csv.gz")
    return out


class FakeRepo:
    def __init__(self, model_row=None, universe=None):
        self.model_row, self.uni = model_row, universe if universe is not None else list(SYMS)
        self.rows: dict[tuple, dict] = {}
        self.next_id = 1

    def active_model(self):
        return self.model_row

    def universe(self):
        return list(self.uni)

    def latest_as_of(self):
        return max((k[0] for k in self.rows), default=None)

    def count_scores(self, as_of):
        return sum(1 for k in self.rows if k[0] == as_of)

    def upsert_scores(self, rows):
        for r in rows:
            k = (r["as_of"], r["symbol"])
            old = self.rows.get(k) or {"id": self.next_id, "outcome_at": None}
            self.next_id += k not in self.rows
            self.rows[k] = {**old, **r}

    def pending_outcomes(self):
        return [{"id": r["id"], "as_of": r["as_of"], "symbol": r["symbol"], "close": r["close"],
                 "atr_pct": r["atr_pct"]} for r in self.rows.values() if r["outcome_at"] is None]

    def write_outcomes(self, rows):
        by = {r["id"]: r for r in self.rows.values()}
        for o in rows:
            by[o["id"]].update(outcome_ret_bp=o["ret_bp"], outcome_big=o["big"], outcome_at=o["at"])


def make_job(tmp_path, repo, now, until, mode="observe", nse=None):
    y = FakeYahoo(load_prices(), until)
    clock_now = {"t": now}
    job = StockMoveJob(repo=repo, models_dir=tmp_path / "models", cache_dir=tmp_path / "cache",
                       now=lambda: clock_now["t"], mode=mode, yahoo_get=y,
                       nse_fetch=nse or (lambda n: ([], [])), eod_get=lambda url: None,
                       sleep=lambda s: None)
    return job, y, clock_now


def test_end_to_end_nightly_scores_then_fills_outcomes(tmp_path):
    make_artifact(tmp_path / "models")
    repo = FakeRepo({"id": "stock-move-20261019", "artifactPath": "stock-move/20261019"})
    job, y, now = make_job(tmp_path, repo, ist("2026-10-09T20:15"), "2026-10-09")
    s = job.run()
    assert s["status"] == "scored" and s["as_of"] == "2026-10-09" and s["scored"] == 3
    rows = [r for k, r in repo.rows.items() if k[0] == date(2026, 10, 9)]
    assert {r["symbol"] for r in rows} == set(SYMS)
    for r in rows:
        assert 0 <= r["p_big"] <= 1 and r["bucket"] in ("TOP20", "MID", "BOTTOM20")
        assert r["model_id"] == "stock-move-20261019" and r["data_quality"] == "ok"
        assert r["close"] == pytest.approx(float(load_prices()[r["symbol"]].set_index("date").close["2026-10-09"]))
        assert len(r["features"]["drivers"]) == 3
    assert max(r["rank_pct"] for r in rows) == 1.0 and all(0 < r["rank_pct"] <= 1 for r in rows)
    # the stored rows equal an offline dry run of the same date (same code path, no DB)
    dr, _ = dry_run(tmp_path / "models" / "stock-move" / "20261019", tmp_path / "cache" / "prices", date(2026, 10, 9))
    assert {r["symbol"]: round(r["p_big"], 12) for r in dr} == {r["symbol"]: round(r["p_big"], 12) for r in rows}
    # same night again: nothing re-scored
    assert job.run()["status"] == "already_scored"
    # a week later: new session scored, 10-09 outcomes filled from the 5 sessions after it
    y.until = pd.Timestamp("2026-10-19")
    now["t"] = ist("2026-10-19T20:15")
    s = job.run()
    assert s["status"] == "scored" and s["as_of"] == "2026-10-19" and s["outcomes"] == 3
    exp = pd.read_csv(Path(__file__).parent / "fixtures" / "stock_move" / "expected_panel.csv.gz", parse_dates=["date"])
    lab = exp[exp.date == "2026-10-09"].set_index("sym")["y_big5_1.5"]
    for sym in SYMS:
        assert repo.rows[(date(2026, 10, 9), sym)]["outcome_big"] == bool(lab[sym])
    assert all(repo.rows[(date(2026, 10, 19), s_)]["outcome_at"] is None for s_ in SYMS)


def test_stale_calendar_is_flagged_and_universe_falls_back_to_the_model(tmp_path):
    make_artifact(tmp_path / "models")

    def down(now):
        raise ConnectionError("nse down")

    class BrokenUniverse(FakeRepo):
        def universe(self):
            raise RuntimeError("permission denied for table instruments")
    repo = BrokenUniverse({"id": "stock-move-20261019", "artifactPath": "stock-move/20261019"})
    job, _, _ = make_job(tmp_path, repo, ist("2026-10-09T20:15"), "2026-10-09", nse=down)
    s = job.run()
    assert s["status"] == "scored" and s["calendar"] == "stale" and s["universe"] == "3(model)"
    assert {r["data_quality"] for r in repo.rows.values()} == {"calendar_stale"}


def test_off_no_model_and_failures_never_raise(tmp_path):
    job, y, _ = make_job(tmp_path, FakeRepo(None), ist("2026-10-09T20:15"), "2026-10-09")
    assert job.run()["status"] == "no_active_model" and y.calls == []
    job, y, _ = make_job(tmp_path, FakeRepo({"id": "x", "artifactPath": "stock-move/x"}), ist("2026-10-09T20:15"),
                         "2026-10-09", mode="off")
    assert job.run()["status"] == "off" and y.calls == []
    job, _, _ = make_job(tmp_path, FakeRepo({"id": "x", "artifactPath": "../../etc"}), ist("2026-10-09T20:15"), "2026-10-09")
    s = job.run()
    assert s["status"] == "failed" and "escapes" in s["error"]
    assert mode_from({}) == "observe" and mode_from({"STOCK_MOVE_ENABLED": "OFF"}) == "off"
    assert mode_from({"STOCK_MOVE_ENABLED": "bogus"}) == "off"


def test_catch_up_only_when_the_expected_session_is_missing(tmp_path):
    repo = FakeRepo({"id": "stock-move-20261019", "artifactPath": "stock-move/20261019"})
    job, _, now = make_job(tmp_path, repo, ist("2026-10-20T10:00"), "2026-10-19")
    assert job.needs_catch_up()                      # nothing scored yet
    repo.rows[(date(2026, 10, 19), "TCS")] = {"id": 1, "outcome_at": None}
    assert not job.needs_catch_up()                  # Monday's rows exist; Tuesday's run is tonight
    now["t"] = ist("2026-10-20T21:00")
    assert job.needs_catch_up()
    assert not make_job(tmp_path, FakeRepo(None), ist("2026-10-20T21:00"), "2026-10-19")[0].needs_catch_up()


def test_model_scores_unknown_sector_and_missing_columns_without_error(tmp_path):
    m = StockMoveModel.load(make_artifact(tmp_path))
    rows = pd.DataFrame({"sector": ["Nope", "Information Technology"], "atr_pct": [0.02, 0.01]})
    out = m.score(rows)
    assert out["p_big"].between(0, 1).all() and list(out["bucket"]) in (["BOTTOM20", "TOP20"], ["TOP20", "BOTTOM20"],
                                                                         ["MID", "MID"])


# ── schedule ───────────────────────────────────────────────────────────────────

def test_next_stock_move_is_weekday_2015_ist():
    assert clock.next_stock_move(ist("2026-10-22T10:00")) == ist("2026-10-22T20:15")
    assert clock.next_stock_move(ist("2026-10-22T20:15")) == ist("2026-10-23T20:15")
    assert clock.next_stock_move(ist("2026-10-23T21:00")) == ist("2026-10-26T20:15")   # Fri -> Mon
    assert clock.expected_stock_move_session(ist("2026-10-26T09:00")) == date(2026, 10, 23)
    assert clock.expected_stock_move_session(ist("2026-10-26T20:15")) == date(2026, 10, 26)


# ── ship script ────────────────────────────────────────────────────────────────

_spec = importlib.util.spec_from_file_location("stock_move_ship",
                                               Path(__file__).resolve().parents[1] / "scripts" / "stock_move_ship.py")
SH = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(SH)

WF = {"auc": 0.67, "auc_last3": 0.66, "mon_min": 0.56, "last3": "2026-08..2026-10", "gate": "GO",
      "checks": {"auc_last3": True, "mon_min": True}}
METRICS = {"built": "2026-10-22", "walkForward": WF, "nTrain": 400000, "nHoldout": 140000}
META = {"featureSet": "sm-daily-er0", "trainedThrough": "2026-10-21", "lastLabelled": "2026-10-14"}


def test_registry_row_and_sql_register_inactive():
    r = SH.registry_row("20261022", METRICS, META)
    assert r["id"] == "stock-move-20261022" and r["kind"] == "stock-move" and r["gate"] == "GO"
    assert r["artifactPath"] == "stock-move/20261022" and r["horizon"] == "5d" and r["instrument"] is None
    sql = SH.registry_sql(r)
    assert sql.startswith("BEGIN;") and sql.rstrip().endswith("COMMIT;")
    assert ", false, NULL, '5d')" in sql and "WHERE NOT ai_models.active" in sql
    assert "UPDATE ai_models SET active = false" not in sql          # shipping never deactivates anything


def test_no_go_is_refused_and_promote_is_one_transaction():
    bad = {**METRICS, "walkForward": {**WF, "gate": "NO_GO", "checks": {"auc_last3": False, "mon_min": True}}}
    r = SH.registry_row("20261022", bad, META)
    assert r["gateReasons"] == ["auc_last3"]
    with pytest.raises(ValueError):
        SH.registry_sql(r)
    p = SH.promote_sql("stock-move-20261022")
    assert p.index("active = false") < p.index("active = true") and "RAISE EXCEPTION" in p


def test_gate_metrics_follow_the_research_gate():
    rng = np.random.default_rng(0)
    dates = np.repeat(pd.date_range("2026-01-05", periods=9, freq="MS").to_numpy(), 400)
    y = rng.random(len(dates)) < 0.1
    p = y * 0.3 + rng.random(len(dates))
    g = SH.gate_metrics(dates, y, p)
    assert g["months"] == 9 and g["gate"] == ("GO" if g["auc_last3"] >= 0.65 and g["mon_min"] >= 0.55 else "NO_GO")
    assert g["auc"] == pytest.approx(SH.auc(y, p))


def test_health_reports_the_stock_move_job(tmp_path, monkeypatch):
    monkeypatch.setenv("MBM_LOOP", "off")
    from fastapi.testclient import TestClient
    try:
        import src.mbm_main as M
    except TypeError as exc:
        pytest.skip(f"fastapi/starlette mismatch in this interpreter: {exc}")

    class StubEngine:
        instruments = []

        def health(self):
            return {"ok": True}

        def load_models(self):
            pass

        def model_summary(self):
            return {}
    job, _, _ = make_job(tmp_path, FakeRepo(None), ist("2026-10-09T20:15"), "2026-10-09")
    job.run()
    try:
        app = M.create_app(engine=StubEngine(), stock_move=job)
    except TypeError as exc:
        pytest.skip(f"fastapi/starlette mismatch in this interpreter: {exc}")
    with TestClient(app) as c:
        h = c.get("/health").json()
    assert h["ok"] and h["stockMove"]["mode"] == "observe" and h["stockMove"]["last"]["status"] == "no_active_model"
    assert M.make_stock_move_job({"STOCK_MOVE_ENABLED": "off"}).mode == "off"
