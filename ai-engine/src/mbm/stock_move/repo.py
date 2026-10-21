"""Stock-move SQL (grw_ai: SELECT instruments + ai_models; SELECT/INSERT/UPDATE stock_move_scores)."""
from __future__ import annotations

from datetime import date
from typing import Any, Protocol

from . import HORIZON_DAYS, KIND, THRESHOLD_ATR

ACTIVE_MODEL_SQL = '''
SELECT "id", "artifactPath" FROM "ai_models"
WHERE "kind" = %(kind)s AND "active" AND "gate" = 'GO'
ORDER BY "createdAt" DESC LIMIT 1'''

# F&O universe: underlyings of live NFO contracts that also have an NSE cash row (SYMBOL-EQ). Index
# underlyings have no -EQ row, so they drop out; test/dummy scrips are filtered by name.
UNIVERSE_SQL = r'''
SELECT DISTINCT f."name" AS symbol FROM "instruments" f
WHERE f."exchange" = 'NFO' AND f."isActive" AND (f."expiry" IS NULL OR f."expiry" >= current_date)
  AND f."name" !~* '(test|dummy)'
  AND EXISTS (SELECT 1 FROM "instruments" c
              WHERE c."exchange" = 'NSE' AND c."isActive" AND c."symbol" = f."name" || '-EQ')
ORDER BY 1'''

LATEST_AS_OF_SQL = '''
SELECT max(as_of) AS as_of FROM stock_move_scores
WHERE horizon_days = %(h)s AND threshold_atr = %(thr)s'''

COUNT_SQL = '''
SELECT count(*) AS n FROM stock_move_scores
WHERE as_of = %(as_of)s AND horizon_days = %(h)s AND threshold_atr = %(thr)s'''

UPSERT_SQL = '''
INSERT INTO stock_move_scores (as_of, symbol, horizon_days, threshold_atr, p_big, rank_pct, bucket,
  results_date, results_in_window, atr_pct, close, features, model_id, data_quality)
VALUES (%(as_of)s, %(symbol)s, %(horizon_days)s, %(threshold_atr)s, %(p_big)s, %(rank_pct)s, %(bucket)s,
  %(results_date)s, %(results_in_window)s, %(atr_pct)s, %(close)s, %(features)s, %(model_id)s, %(data_quality)s)
ON CONFLICT (as_of, symbol, horizon_days, threshold_atr) DO UPDATE SET
  p_big = EXCLUDED.p_big, rank_pct = EXCLUDED.rank_pct, bucket = EXCLUDED.bucket,
  results_date = EXCLUDED.results_date, results_in_window = EXCLUDED.results_in_window,
  atr_pct = EXCLUDED.atr_pct, close = EXCLUDED.close, features = EXCLUDED.features,
  model_id = EXCLUDED.model_id, data_quality = EXCLUDED.data_quality'''

PENDING_SQL = '''
SELECT id, as_of, symbol, close, atr_pct FROM stock_move_scores
WHERE outcome_at IS NULL AND horizon_days = %(h)s AND threshold_atr = %(thr)s
ORDER BY as_of, symbol'''

WRITE_OUTCOME_SQL = '''
UPDATE stock_move_scores SET outcome_ret_bp = %(ret_bp)s, outcome_big = %(big)s, outcome_at = %(at)s
WHERE id = %(id)s AND outcome_at IS NULL'''


class StockMoveRepo(Protocol):
    def active_model(self) -> dict[str, Any] | None: ...
    def universe(self) -> list[str]: ...
    def latest_as_of(self) -> date | None: ...
    def count_scores(self, as_of: date) -> int: ...
    def upsert_scores(self, rows: list[dict[str, Any]]) -> None: ...
    def pending_outcomes(self) -> list[dict[str, Any]]: ...
    def write_outcomes(self, rows: list[dict[str, Any]]) -> None: ...


class PgStockMoveRepo:
    """One short-lived connection per call, like service/repo.py."""

    def __init__(self, url: str):
        self.url = url

    def _conn(self):
        import psycopg
        from psycopg.rows import dict_row
        return psycopg.connect(self.url, connect_timeout=10, row_factory=dict_row)

    def _fetch(self, sql: str, params: dict | None = None) -> list[dict[str, Any]]:
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute(sql, params or {})
            return list(cur.fetchall())

    def _execmany(self, sql: str, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        with self._conn() as conn, conn.cursor() as cur:
            cur.executemany(sql, rows)

    def active_model(self) -> dict[str, Any] | None:
        rows = self._fetch(ACTIVE_MODEL_SQL, {"kind": KIND})
        return rows[0] if rows else None

    def universe(self) -> list[str]:
        return [str(r["symbol"]) for r in self._fetch(UNIVERSE_SQL)]

    def latest_as_of(self) -> date | None:
        rows = self._fetch(LATEST_AS_OF_SQL, {"h": HORIZON_DAYS, "thr": THRESHOLD_ATR})
        return rows[0]["as_of"] if rows else None

    def count_scores(self, as_of: date) -> int:
        return int(self._fetch(COUNT_SQL, {"as_of": as_of, "h": HORIZON_DAYS, "thr": THRESHOLD_ATR})[0]["n"])

    def upsert_scores(self, rows: list[dict[str, Any]]) -> None:
        from psycopg.types.json import Jsonb
        self._execmany(UPSERT_SQL, [{**r, "features": Jsonb(r["features"])} for r in rows])

    def pending_outcomes(self) -> list[dict[str, Any]]:
        return self._fetch(PENDING_SQL, {"h": HORIZON_DAYS, "thr": THRESHOLD_ATR})

    def write_outcomes(self, rows: list[dict[str, Any]]) -> None:
        self._execmany(WRITE_OUTCOME_SQL, rows)
