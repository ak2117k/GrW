"""MBM M2 serving: schedule math, the prediction run on a fake bars table, the outcome filler,
endpoint statuses and the models-absent path. No Postgres: SQL sits behind `FakeRepo`."""
from datetime import datetime, timedelta

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from src.mbm import features as F
from src.mbm.service import clock
from src.mbm.service.daily import YAHOO_SYMBOLS, fetch_global_daily
from src.mbm.service.engine import Engine, build_inputs, has_gap, universe
from src.mbm.universe import yahoo_series_id
from tests.test_mbm_features import _bars_1m, _daily

IST = clock.IST
EMPTY = pd.DataFrame(columns=["series", "ts", "open", "high", "low", "close", "volume"])
DAYS = pd.bdate_range("2026-08-31", "2026-10-14")          # ~33 sessions, ends Wed 14 Oct


def ist(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=IST)


class FakeRepo:
    def __init__(self, bars: pd.DataFrame, models=None):
        self.df = bars
        self.models = models or []
        self.preds: dict[tuple, dict] = {}
        self.next_id = 1

    def active_models(self, instrument):
        return [m for m in self.models if m["instrument"] == instrument]

    def bars(self, series, start, end):
        d = self.df
        m = d["series"].isin(series) & (d["ts"] >= pd.Timestamp(start)) & (d["ts"] < pd.Timestamp(end))
        return d[m].reset_index(drop=True)

    def newest_bar_ts(self, series):
        s = self.df.loc[self.df["series"] == series, "ts"]
        return None if s.empty else s.max().to_pydatetime()

    def upsert_predictions(self, rows):
        for r in rows:
            key = (r["instrument"], r["horizon"], pd.Timestamp(r["as_of"]))
            old = self.preds.get(key, {"id": self.next_id, "outcome_at": None})
            if old["id"] == self.next_id:
                self.next_id += 1
            self.preds[key] = {**old, **r}

    def pending_outcomes(self, instrument):
        return [{"id": p["id"], "horizon": p["horizon"], "as_of": p["as_of"]}
                for k, p in sorted(self.preds.items(), key=lambda kv: kv[0][2])
                if k[0] == instrument and p["outcome_at"] is None]

    def write_outcomes(self, rows):
        by_id = {p["id"]: p for p in self.preds.values()}
        for r in rows:
            by_id[r["id"]].update({"outcome_range_bp": r["range_bp"], "outcome_threshold_bp": r["threshold_bp"],
                                   "outcome_big": r["big"], "outcome_quality": r["quality"], "outcome_at": r["at"]})

    def latest_predictions(self, instrument, since):
        rows = [p for k, p in self.preds.items() if k[0] == instrument and k[2] >= pd.Timestamp(since)]
        if not rows:
            return []
        top = max(pd.Timestamp(r["as_of"]) for r in rows)
        return sorted([r for r in rows if pd.Timestamp(r["as_of"]) == top], key=lambda r: r["horizon"])


class StubModel:
    """Stands in for HorizonModel: records the rows it scored."""
    feature_set = "mbm-fs2"

    def __init__(self, p=0.8):
        self.p, self.seen = p, []

    def predict(self, rows):
        self.seen.append(rows)
        return pd.DataFrame({"p": [self.p] * len(rows), "regime": ["ACTIVE"] * len(rows),
                             "q25_bp": 30.0, "q50_bp": 40.0, "q75_bp": 55.5}, index=rows.index)


def _rows(series: str, df: pd.DataFrame) -> pd.DataFrame:
    d = df.drop(columns="oi").copy()
    d.insert(0, "series", series)
    return d


@pytest.fixture(scope="module")
def table():
    parts = [_rows("NIFTY", _bars_1m(DAYS, 1, base=25000)), _rows(F.BANKNIFTY, _bars_1m(DAYS, 2, base=55000)),
             _rows(F.VIX, _bars_1m(DAYS, 3, base=12, vol=False))]
    parts += [_rows(s, _bars_1m(DAYS, 10 + i, base=1000)) for i, s in enumerate(F.HEAVYWEIGHTS)]
    return pd.concat(parts, ignore_index=True)


@pytest.fixture(scope="module")
def gdaily():
    return {n: _daily(DAYS, 40 + i) for i, n in enumerate(F.GLOBAL_DAILY)}


def _engine(repo, now, models=None, gd=None):
    e = Engine(repo=repo, models_dir=__import__("pathlib").Path("."), instruments=["NIFTY"], now=lambda: now)
    e.models = {"NIFTY": models if models is not None else {}}
    e.global_daily = gd or {}
    return e


def _loaded(**hs):
    from src.mbm.service.engine import LoadedModel
    return {h: LoadedModel(f"mbm-move-nifty-{h}-x", m) for h, m in hs.items()}


# ---------------------------------------------------------------- clock

@pytest.mark.parametrize("now,expected", [
    ("2026-10-14T08:00:00", "2026-10-14T09:20:45"),
    ("2026-10-14T09:20:44", "2026-10-14T09:20:45"),
    ("2026-10-14T09:20:45", "2026-10-14T09:25:45"),
    ("2026-10-14T11:02:10", "2026-10-14T11:05:45"),
    ("2026-10-14T11:05:30", "2026-10-14T11:05:45"),
    ("2026-10-14T15:30:44", "2026-10-14T15:30:45"),
    ("2026-10-14T15:30:45", "2026-10-15T09:20:45"),
    ("2026-10-16T16:00:00", "2026-10-19T09:20:45"),   # Friday evening -> Monday
    ("2026-10-17T10:00:00", "2026-10-19T09:20:45"),   # Saturday
])
def test_next_run(now, expected):
    assert clock.next_run(ist(now)) == ist(expected)


def test_next_run_accepts_utc_clock():
    assert clock.next_run(ist("2026-10-14T11:02:10").astimezone(clock.IST).astimezone(
        __import__("datetime").timezone.utc)) == ist("2026-10-14T11:05:45")


@pytest.mark.parametrize("now,as_of", [
    ("2026-10-14T09:20:45", "2026-10-14T09:20:00"),
    ("2026-10-14T13:47:59", "2026-10-14T13:45:00"),
    ("2026-10-14T15:30:45", "2026-10-14T15:30:00"),
    ("2026-10-14T09:19:59", None),
    ("2026-10-14T15:35:45", None),
    ("2026-10-17T11:00:45", None),
])
def test_as_of_window(now, as_of):
    got = clock.as_of_for(ist(now))
    assert got == (ist(as_of) if as_of else None)


def test_daily_refresh_time():
    assert clock.next_daily_refresh(ist("2026-10-14T08:00:00")) == ist("2026-10-14T08:30:00")
    assert clock.next_daily_refresh(ist("2026-10-14T08:30:00")) == ist("2026-10-15T08:30:00")


def test_naive_clock_rejected():
    with pytest.raises(ValueError):
        clock.as_of_for(datetime(2026, 10, 14, 11, 0))


# ---------------------------------------------------------------- global daily

def test_yahoo_symbols_match_feature_series():
    assert {n: yahoo_series_id(s) for n, s in YAHOO_SYMBOLS.items()} == F.GLOBAL_DAILY


def test_global_daily_failure_leaves_name_out():
    from src.mbm.angel import FetchResult

    def fetch(sym, interval, start, end):
        if sym == "CL=F":
            raise RuntimeError("boom")
        return FetchResult(df=_daily(DAYS, 1), failed=[], calls=1)
    out = fetch_global_daily(ist("2026-10-14T08:30:00"), fetch=fetch)
    assert set(out) == set(YAHOO_SYMBOLS) - {"cl"}


# ---------------------------------------------------------------- prediction

AS_OF = ist("2026-10-14T11:00:00")


def test_predict_uses_training_feature_path(table, gdaily):
    m30, m60 = StubModel(0.8), StubModel(0.2)
    e = _engine(FakeRepo(table), AS_OF + timedelta(seconds=45), _loaded(**{"30m": m30, "60m": m60}), gdaily)
    rows = e.predict_once("NIFTY", AS_OF)
    assert [r["horizon"] for r in rows] == ["30m", "60m"]
    assert all(r["data_quality"] == "ok" and r["as_of"] == AS_OF for r in rows)
    assert rows[0]["model_id"] == "mbm-move-nifty-30m-x" and rows[0]["q75_bp"] == 55.5
    scored = m30.seen[0]
    assert len(scored) == 1 and scored.index[0] == pd.Timestamp(AS_OF)
    # Same row as the training pipeline on the same bars (ts < as_of).
    ref_bars = table[table["ts"] < pd.Timestamp(AS_OF)]
    ref = F.build_features(build_inputs(ref_bars[ref_bars["series"].isin(universe("NIFTY"))], "NIFTY", gdaily))
    pd.testing.assert_series_equal(scored.iloc[0], ref.loc[pd.Timestamp(AS_OF)], check_names=False)
    assert scored[[c for c in scored.columns if c.startswith("gd_")]].notna().any(axis=1).iloc[0]


def test_predict_skips_stale_when_last_minute_missing(table, gdaily):
    t = table[~((table["series"] == "NIFTY") & (table["ts"] == pd.Timestamp(AS_OF) - timedelta(minutes=1)))]
    e = _engine(FakeRepo(t), AS_OF, _loaded(**{"30m": StubModel()}), gdaily)
    assert e.predict_once("NIFTY", AS_OF) == []


def test_predict_ignores_a_forming_bar_at_as_of(table, gdaily):
    e = _engine(FakeRepo(table), AS_OF, _loaded(**{"30m": StubModel()}), gdaily)
    rows = e.predict_once("NIFTY", AS_OF)   # table holds bars at/after AS_OF too
    assert len(rows) == 1 and rows[0]["as_of"] == AS_OF


def test_data_quality_gap_and_drivers(table, gdaily):
    a = pd.Timestamp(AS_OF)
    gap = table[~((table["series"] == "NIFTY") & (table["ts"] >= a - timedelta(minutes=20))
                  & (table["ts"] < a - timedelta(minutes=17)))]
    e = _engine(FakeRepo(gap), AS_OF, _loaded(**{"30m": StubModel()}), gdaily)
    assert e.predict_once("NIFTY", AS_OF)[0]["data_quality"] == "gap"
    novix = table[table["series"] != F.VIX]
    e = _engine(FakeRepo(novix), AS_OF, _loaded(**{"30m": StubModel()}), gdaily)
    assert e.predict_once("NIFTY", AS_OF)[0]["data_quality"] == "drivers_missing"
    e = _engine(FakeRepo(table), AS_OF, _loaded(**{"30m": StubModel()}), {})
    assert e.predict_once("NIFTY", AS_OF)[0]["data_quality"] == "drivers_missing"


def test_has_gap_two_missing_minutes_is_tolerated():
    a = pd.Timestamp(AS_OF)
    ts = pd.Series(pd.date_range(a - timedelta(minutes=30), a - timedelta(minutes=1), freq="1min"))
    assert not has_gap(pd.DataFrame({"ts": ts}), AS_OF)
    assert not has_gap(pd.DataFrame({"ts": ts.drop([5, 6])}), AS_OF)
    assert has_gap(pd.DataFrame({"ts": ts.drop([5, 6, 7])}), AS_OF)
    assert has_gap(pd.DataFrame({"ts": ts.iloc[:-3]}), AS_OF)       # tail missing
    open_ = ist("2026-10-14T09:20:00")                               # window clipped at 09:15
    o = pd.Series(pd.date_range(ist("2026-10-14T09:15:00"), periods=5, freq="1min"))
    assert not has_gap(pd.DataFrame({"ts": o}), open_)


def test_run_once_writes_predictions_in_window_only(table, gdaily):
    repo = FakeRepo(table)
    e = _engine(repo, AS_OF + timedelta(seconds=45), _loaded(**{"30m": StubModel(), "60m": StubModel()}), gdaily)
    res = e.run_once()
    assert res["predictions"] == 2 and len(repo.preds) == 2 and e.last_run is not None
    e.now = lambda: ist("2026-10-17T11:00:45")                      # Saturday
    assert e.run_once()["predictions"] == 0


# ---------------------------------------------------------------- outcomes

def _nifty_only(table):
    return table[table["series"] == "NIFTY"].reset_index(drop=True)


def _expected_range_bp(nifty, a, mins):
    w = nifty[(nifty["ts"] >= a) & (nifty["ts"] < a + timedelta(minutes=mins))]
    c0 = nifty.loc[nifty["ts"] < a, "close"].iloc[-1]
    return (w["high"].max() - w["low"].min()) / c0 * 1e4


def test_outcome_filler_matches_label_definition(table):
    nifty = _nifty_only(table)
    repo = FakeRepo(nifty)
    a = pd.Timestamp(AS_OF)
    repo.upsert_predictions([{"instrument": "NIFTY", "horizon": "30m", "as_of": AS_OF, "p": 0.5}])
    e = _engine(repo, ist("2026-10-14T16:00:00"))
    assert e.fill_outcomes("NIFTY") == 1
    p = next(iter(repo.preds.values()))
    exp = _expected_range_bp(nifty, a, 30)
    assert p["outcome_range_bp"] == pytest.approx(exp)
    # threshold: median of the same-minute 30m range over the previous sessions (all < 60, >= 20).
    prev = [_expected_range_bp(nifty, pd.Timestamp(d.date().isoformat() + " 11:00", tz=IST), 30) for d in DAYS[:-1]]
    assert p["outcome_threshold_bp"] == pytest.approx(np.median(prev))
    assert p["outcome_big"] == (exp > np.median(prev))
    assert p["outcome_quality"] == "ok" and p["outcome_at"] is not None
    assert e.fill_outcomes("NIFTY") == 0                             # filled once


def test_outcome_waits_for_window_and_flags_gaps(table):
    nifty = _nifty_only(table)
    a = pd.Timestamp(AS_OF)
    early = nifty[nifty["ts"] < a + timedelta(minutes=20)]
    repo = FakeRepo(early)
    repo.upsert_predictions([{"instrument": "NIFTY", "horizon": "30m", "as_of": AS_OF, "p": 0.5}])
    e = _engine(repo, AS_OF + timedelta(minutes=20))
    assert e.fill_outcomes("NIFTY") == 0                             # window not closed
    repo.df = nifty[nifty["ts"] != a + timedelta(minutes=7)]          # closed, one minute missing
    assert e.fill_outcomes("NIFTY") == 1
    assert next(iter(repo.preds.values()))["outcome_quality"] == "gap"


def test_outcome_threshold_null_with_few_sessions(table):
    nifty = _nifty_only(table)
    nifty = nifty[nifty["ts"] >= pd.Timestamp("2026-10-01", tz=IST)]  # 10 sessions < 20
    repo = FakeRepo(nifty)
    repo.upsert_predictions([{"instrument": "NIFTY", "horizon": "60m", "as_of": AS_OF, "p": 0.5}])
    _engine(repo, ist("2026-10-14T16:00:00")).fill_outcomes("NIFTY")
    p = next(iter(repo.preds.values()))
    assert p["outcome_range_bp"] is not None and p["outcome_threshold_bp"] is None and p["outcome_big"] is None


def test_outcome_window_past_session_end_is_closed_as_gap(table):
    nifty = _nifty_only(table)
    late = ist("2026-10-14T15:15:00")
    repo = FakeRepo(nifty)
    repo.upsert_predictions([{"instrument": "NIFTY", "horizon": "30m", "as_of": late, "p": 0.5}])
    assert _engine(repo, ist("2026-10-14T15:31:00")).fill_outcomes("NIFTY") == 1
    p = next(iter(repo.preds.values()))
    assert p["outcome_range_bp"] is None and p["outcome_quality"] == "gap"


# ---------------------------------------------------------------- endpoints

def _client(engine, monkeypatch):
    monkeypatch.setenv("MBM_LOOP", "off")
    try:
        from fastapi import FastAPI
        FastAPI()
    except TypeError as exc:  # fastapi 0.115 + starlette >= 1 in a dev interpreter; pinned in the image
        pytest.skip(f"fastapi/starlette mismatch in this interpreter: {exc}")
    from src.mbm_main import create_app
    engine.load_models = lambda *a, **k: None
    return TestClient(create_app(engine))


def _pred(as_of, h="30m", dq="ok"):
    return {"instrument": "NIFTY", "horizon": h, "as_of": as_of, "p": 0.891234, "regime": "ACTIVE",
            "q25_bp": 34.04, "q50_bp": 45.0, "q75_bp": 59.0, "model_id": f"mbm-move-nifty-{h}-x",
            "feature_set": "mbm-fs2", "data_quality": dq}


@pytest.mark.parametrize("now,status", [
    ("2026-10-14T11:05:00", "ok"),
    ("2026-10-14T11:10:00", "ok"),
    ("2026-10-14T11:20:00", "stale"),
    ("2026-10-14T20:00:00", "absent"),        # outside session
    ("2026-10-15T09:30:00", "absent"),        # none today
])
def test_behaviour_status(now, status, monkeypatch):
    repo = FakeRepo(EMPTY)
    repo.upsert_predictions([_pred(AS_OF), _pred(AS_OF, "60m", "gap"),
                             _pred(AS_OF - timedelta(minutes=5))])
    e = _engine(repo, ist(now))
    with _client(e, monkeypatch) as c:
        body = c.get("/behaviour/nifty").json()
    assert body["status"] == status and body["instrument"] == "NIFTY"
    if status != "absent":
        assert body["asOf"] == "2026-10-14T05:30:00Z"
        assert body["horizons"]["30m"] == {"p": 0.8912, "regime": "ACTIVE", "q25Bp": 34.0, "q50Bp": 45.0, "q75Bp": 59.0}
        assert body["modelIds"] == {"30m": "mbm-move-nifty-30m-x", "60m": "mbm-move-nifty-60m-x"}
        assert body["featureSet"] == "mbm-fs2" and body["dataQuality"] == "gap"
    else:
        assert body["horizons"] == {}


def test_behaviour_absent_without_db_or_on_db_error(monkeypatch):
    e = _engine(None, AS_OF)
    with _client(e, monkeypatch) as c:
        r = c.get("/behaviour/NIFTY")
    assert r.status_code == 200 and r.json()["status"] == "absent"

    class Broken(FakeRepo):
        def latest_predictions(self, *a):
            raise OSError("db down")
    e = _engine(Broken(pd.DataFrame()), AS_OF)
    with _client(e, monkeypatch) as c:
        r = c.get("/behaviour/NIFTY")
    assert r.status_code == 200 and r.json()["status"] == "absent"


def test_health(monkeypatch):
    e = _engine(FakeRepo(EMPTY), AS_OF, _loaded(**{"30m": StubModel(), "60m": StubModel()}))
    e.last_run = AS_OF
    with _client(e, monkeypatch) as c:
        assert c.get("/health").json() == {"ok": True, "models": {"NIFTY": ["30m", "60m"]},
                                           "lastRun": "2026-10-14T05:30:00Z"}


# ---------------------------------------------------------------- models absent

def test_models_absent_path(tmp_path):
    good = tmp_path / "mbm/nifty/v1/30m"
    good.mkdir(parents=True)
    rows = [{"instrument": "NIFTY", "id": "a", "horizon": "30m", "artifactPath": "mbm/nifty/v1/30m", "featureSet": "mbm-fs2"},
            {"instrument": "NIFTY", "id": "b", "horizon": "60m", "artifactPath": "mbm/nifty/v1/60m", "featureSet": "mbm-fs2"},
            {"instrument": "NIFTY", "id": "c", "horizon": "60m", "artifactPath": "../../etc", "featureSet": "mbm-fs2"}]
    e = Engine(repo=FakeRepo(EMPTY, rows), models_dir=tmp_path, instruments=["NIFTY", "BANKNIFTY"],
               now=lambda: AS_OF)
    e.load_models(loader=lambda d: StubModel() if d == good.resolve() else (_ for _ in ()).throw(FileNotFoundError(d)))
    assert e.model_summary() == {"NIFTY": ["30m"], "BANKNIFTY": []}
    assert e.run_once()["predictions"] == 0                            # never raises
    e2 = Engine(repo=None, models_dir=tmp_path, instruments=["NIFTY"], now=lambda: AS_OF)
    e2.load_models()
    assert e2.health()["models"] == {"NIFTY": []} and e2.behaviour("NIFTY")["status"] == "absent"


def test_real_loader_on_missing_dir_is_absent(tmp_path):
    rows = [{"instrument": "NIFTY", "id": "a", "horizon": "30m", "artifactPath": "nope/30m", "featureSet": "mbm-fs2"}]
    e = Engine(repo=FakeRepo(EMPTY, rows), models_dir=tmp_path, instruments=["NIFTY"], now=lambda: AS_OF)
    e.load_models()
    assert e.model_summary() == {"NIFTY": []}
