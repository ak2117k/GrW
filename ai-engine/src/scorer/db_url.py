"""The scorer's read-only DB URL, safe for any password.

docker-compose used to interpolate AI_DB_PASSWORD straight into AI_DB_URL, so a
password containing '@', ':', '/', '?', '#', '%' or '+' produced a broken URL. Compose
now passes the parts and the URL is assembled here with every component
percent-escaped. An explicit AI_DB_URL still wins (local runs, tests).
"""
from __future__ import annotations

from collections.abc import Mapping
from urllib.parse import quote


def ai_db_url(env: Mapping[str, str]) -> str | None:
    explicit = (env.get("AI_DB_URL") or "").strip()
    if explicit:
        return explicit
    password = env.get("AI_DB_PASSWORD") or ""
    if not password:
        return None
    user = env.get("AI_DB_USER") or "grw_ai"
    host = env.get("AI_DB_HOST") or "postgres"
    port = env.get("AI_DB_PORT") or "5432"
    name = env.get("AI_DB_NAME") or "grw"
    return (
        f"postgresql://{quote(user, safe='')}:{quote(password, safe='')}"
        f"@{host}:{port}/{quote(name, safe='')}"
    )
