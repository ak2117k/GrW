"""All MBM serving SQL, behind one small class (tests use `tests.test_mbm_service.FakeRepo`).

Tables per the M2 contract: `mbm_bars_1m` (read), `ai_models` (read), `mbm_predictions`
(read/insert/update), `mbm_daily_signals` (read/insert/update) — exactly the grants the `grw_ai` role has. One short-lived connection
per call: the loop runs every 5 minutes, so pooling buys nothing and a dropped connection
can never wedge the service.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any, Protocol

import pandas as pd

KIND = "mbm-move"

ACTIVE_MODELS_SQL = '''
SELECT "id", "horizon", "artifactPath", "featureSet" FROM "ai_models"
WHERE "kind" = %(kind)s AND "instrument" = %(instrument)s AND "active" AND "gate" = 'GO'
ORDER BY "horizon"'''

BARS_SQL = '''
SELECT series, ts, open, high, low, close, volume FROM mbm_bars_1m
WHERE series = ANY(%(series)s) AND ts >= %(start)s AND ts < %(end)s
ORDER BY series, ts'''

NEWEST_BAR_SQL = "SELECT max(ts) AS ts FROM mbm_bars_1m WHERE series = %(series)s"

UPSERT_PREDICTION_SQL = '''
INSERT INTO mbm_predictions (instrument, horizon, as_of, p, regime, q25_bp, q50_bp, q75_bp,
  model_id, feature_set, data_quality)
VALUES (%(instrument)s, %(horizon)s, %(as_of)s, %(p)s, %(regime)s, %(q25_bp)s, %(q50_bp)s,
  %(q75_bp)s, %(model_id)s, %(feature_set)s, %(data_quality)s)
ON CONFLICT (instrument, horizon, as_of) DO UPDATE SET
  p = EXCLUDED.p, regime = EXCLUDED.regime, q25_bp = EXCLUDED.q25_bp, q50_bp = EXCLUDED.q50_bp,
  q75_bp = EXCLUDED.q75_bp, model_id = EXCLUDED.model_id, feature_set = EXCLUDED.feature_set,
  data_quality = EXCLUDED.data_quality'''

PENDING_OUTCOMES_SQL = '''
SELECT id, horizon, as_of FROM mbm_predictions
WHERE instrument = %(instrument)s AND outcome_at IS NULL ORDER BY as_of'''

WRITE_OUTCOME_SQL = '''
UPDATE mbm_predictions SET outcome_range_bp = %(range_bp)s, outcome_threshold_bp = %(threshold_bp)s,
  outcome_big = %(big)s, outcome_quality = %(quality)s, outcome_at = %(at)s
WHERE id = %(id)s AND outcome_at IS NULL'''

LATEST_SQL = '''
SELECT horizon, as_of, p, regime, q25_bp, q50_bp, q75_bp, model_id, feature_set, data_quality
FROM mbm_predictions
WHERE instrument = %(instrument)s AND as_of = (
  SELECT max(as_of) FROM mbm_predictions WHERE instrument = %(instrument)s AND as_of >= %(since)s)
ORDER BY horizon'''

UPSERT_DAILY_SIGNAL_SQL = '''
INSERT INTO mbm_daily_signals (instrument, signal_date, setup, action, close, details)
VALUES (%(instrument)s, %(signal_date)s, %(setup)s, %(action)s, %(close)s, %(details)s)
ON CONFLICT (instrument, signal_date, setup) DO UPDATE SET
  action = EXCLUDED.action, close = EXCLUDED.close, details = EXCLUDED.details'''

PENDING_DAILY_OUTCOMES_SQL = '''
SELECT id, signal_date, ret_5d_bp, ret_10d_bp, ret_20d_bp FROM mbm_daily_signals
WHERE instrument = %(instrument)s AND outcome_at IS NULL ORDER BY signal_date'''

WRITE_DAILY_OUTCOME_SQL = '''
UPDATE mbm_daily_signals SET ret_5d_bp = COALESCE(ret_5d_bp, %(ret_5d_bp)s),
  ret_10d_bp = COALESCE(ret_10d_bp, %(ret_10d_bp)s), ret_20d_bp = COALESCE(ret_20d_bp, %(ret_20d_bp)s),
  outcome_at = %(at)s
WHERE id = %(id)s AND outcome_at IS NULL'''

RECENT_DAILY_SIGNALS_SQL = '''
SELECT signal_date, setup, action FROM mbm_daily_signals
WHERE instrument = %(instrument)s AND signal_date >= %(since)s ORDER BY signal_date DESC, setup'''

BAR_FRAME_COLUMNS =["series", "ts", "open", "high", "low", "close", "volume"]


class Repo(Protocol):
    def active_models(self, instrument: str) -> list[dict[str, Any]]: ...
    def bars(self, series: list[str], start: datetime, end: datetime) -> pd.DataFrame: ...
    def newest_bar_ts(self, series: str) -> datetime | None: ...
    def upsert_predictions(self, rows: list[dict[str, Any]]) -> None: ...
    def pending_outcomes(self, instrument: str) -> list[dict[str, Any]]: ...
    def write_outcomes(self, rows: list[dict[str, Any]]) -> None: ...
    def latest_predictions(self, instrument: str, since: datetime) -> list[dict[str, Any]]: ...
    def upsert_daily_signals(self, rows: list[dict[str, Any]]) -> None: ...
    def pending_daily_outcomes(self, instrument: str) -> list[dict[str, Any]]: ...
    def write_daily_outcomes(self, rows: list[dict[str, Any]]) -> None: ...
    def recent_daily_signals(self, instrument: str, since: date) -> list[dict[str, Any]]: ...


class PgRepo:
    def __init__(self, url: str):
        self.url = url

    def _conn(self):
        import psycopg
        from psycopg.rows import dict_row
        return psycopg.connect(self.url, connect_timeout=10, row_factory=dict_row)

    def _fetch(self, sql: str, params: dict) -> list[dict[str, Any]]:
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute(sql, params)
            return list(cur.fetchall())

    def _execmany(self, sql: str, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        with self._conn() as conn, conn.cursor() as cur:   # commits on clean exit
            cur.executemany(sql, rows)

    def active_models(self, instrument: str) -> list[dict[str, Any]]:
        return self._fetch(ACTIVE_MODELS_SQL, {"kind": KIND, "instrument": instrument})

    def bars(self, series: list[str], start: datetime, end: datetime) -> pd.DataFrame:
        rows = self._fetch(BARS_SQL, {"series": list(series), "start": start, "end": end})
        return pd.DataFrame(rows, columns=BAR_FRAME_COLUMNS)

    def newest_bar_ts(self, series: str) -> datetime | None:
        rows = self._fetch(NEWEST_BAR_SQL, {"series": series})
        return rows[0]["ts"] if rows else None

    def upsert_predictions(self, rows: list[dict[str, Any]]) -> None:
        self._execmany(UPSERT_PREDICTION_SQL, rows)

    def pending_outcomes(self, instrument: str) -> list[dict[str, Any]]:
        return self._fetch(PENDING_OUTCOMES_SQL, {"instrument": instrument})

    def write_outcomes(self, rows: list[dict[str, Any]]) -> None:
        self._execmany(WRITE_OUTCOME_SQL, rows)

    def latest_predictions(self, instrument: str, since: datetime) -> list[dict[str, Any]]:
        return self._fetch(LATEST_SQL, {"instrument": instrument, "since": since})

    def upsert_daily_signals(self, rows: list[dict[str, Any]]) -> None:
        from psycopg.types.json import Jsonb
        self._execmany(UPSERT_DAILY_SIGNAL_SQL, [{**r, "details": Jsonb(r["details"])} for r in rows])

    def pending_daily_outcomes(self, instrument: str) -> list[dict[str, Any]]:
        return self._fetch(PENDING_DAILY_OUTCOMES_SQL, {"instrument": instrument})

    def write_daily_outcomes(self, rows: list[dict[str, Any]]) -> None:
        self._execmany(WRITE_DAILY_OUTCOME_SQL, rows)

    def recent_daily_signals(self, instrument: str, since: date) -> list[dict[str, Any]]:
        return self._fetch(RECENT_DAILY_SIGNALS_SQL, {"instrument": instrument, "since": since})
