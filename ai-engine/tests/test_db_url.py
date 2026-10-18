from urllib.parse import urlsplit, unquote

from src.scorer.db_url import ai_db_url


def test_explicit_url_wins():
    assert ai_db_url({"AI_DB_URL": "postgresql://a:b@h:1/d", "AI_DB_PASSWORD": "x"}) == "postgresql://a:b@h:1/d"


def test_none_without_url_or_password():
    assert ai_db_url({}) is None
    assert ai_db_url({"AI_DB_URL": "  ", "AI_DB_PASSWORD": ""}) is None


def test_builds_from_parts_with_defaults():
    assert ai_db_url({"AI_DB_PASSWORD": "abc", "AI_DB_NAME": "grw"}) == "postgresql://grw_ai:abc@postgres:5432/grw"


def test_password_with_url_metacharacters_is_escaped_and_round_trips():
    pw = "p@ss:w/rd?#%+ ="
    url = ai_db_url({"AI_DB_PASSWORD": pw, "AI_DB_USER": "u@x", "AI_DB_HOST": "db", "AI_DB_PORT": "6543", "AI_DB_NAME": "n"})
    parts = urlsplit(url)
    assert parts.hostname == "db"
    assert parts.port == 6543
    assert parts.path == "/n"
    assert unquote(parts.password) == pw
    assert unquote(parts.username) == "u@x"
