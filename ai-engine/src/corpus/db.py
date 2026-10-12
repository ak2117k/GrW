"""psycopg 3 connection helper for the corpus jobs."""
from __future__ import annotations

import psycopg
from psycopg.rows import dict_row


def connect(url: str) -> "psycopg.Connection":
    """Open a connection with ``autocommit=False`` and dict rows. Caller commits/closes."""
    return psycopg.connect(url, autocommit=False, row_factory=dict_row)
