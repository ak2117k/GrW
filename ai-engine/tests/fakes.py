"""In-memory stand-ins for psycopg connections used by the corpus jobs."""
from __future__ import annotations

from datetime import datetime, timezone


def _utc(d):
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


class FakeCursor:
    def __init__(self, conn):
        self.conn = conn
        self._rows: list = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.conn.executed.append((sql, params))
        if "INSERT INTO \"ai_decision_records\"" in sql:
            key = (params["source"], params["sourceId"])
            inserted = key not in self.conn.records
            prev = self.conn.records.get(key, {})
            row = dict(params)
            if not inserted:
                row["id"] = prev["id"]
                if row["outcome"] is None:
                    row["outcome"], row["outcomeAt"] = prev.get("outcome"), prev.get("outcomeAt")
            self.conn.records[key] = row
            self._rows = [{"inserted": inserted}]
        elif 'FROM "ai_calls"' in sql:
            self._rows = [c for c in self.conn.ai_calls if c["job"].startswith("sentinel.") and c["response"] is not None]
        elif 'FROM "sentinel_verdicts"' in sql:
            lo, hi, uid = _utc(params["lo"]), _utc(params["hi"]), params["userId"]
            self._rows = [v for v in self.conn.verdicts
                          if lo <= _utc(v["createdAt"]) <= hi and (uid is None or v["userId"] == uid)]
        else:
            for key, rows in self.conn.tables.items():
                if f'FROM "{key}"' in sql:
                    self._rows = list(rows)
                    break
            else:
                raise AssertionError(f"unexpected SQL: {sql[:120]}")

    def fetchall(self):
        return list(self._rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None


class FakeConn:
    def __init__(self, tables=None, ai_calls=None, verdicts=None):
        self.tables = tables or {}
        self.ai_calls = ai_calls or []
        self.verdicts = verdicts or []
        self.records: dict = {}
        self.executed: list = []
        self.commits = 0
        self.rollbacks = 0

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1
