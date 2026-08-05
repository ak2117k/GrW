"""
One-time Telegram login -> prints a Telethon StringSession for TELEGRAM_SESSION.

The listener (ai-engine/src/services/telegram_listener.py) authenticates to
Telegram with a REUSABLE StringSession instead of logging in on every start.
Run this ONCE on a trusted machine, complete the phone + login-code prompt, then
store the printed string as TELEGRAM_SESSION (encrypted at rest — see
docs/guides/telegram-listener-runbook.md). NEVER commit it: it is full,
password-less access to the logged-in account.

Prerequisites
-------------
1. Get api_id + api_hash from https://my.telegram.org  (API development tools).
2. Install Telethon:   py -m pip install telethon
3. Run (Windows PowerShell — your primary shell):
     $env:TELEGRAM_API_ID='12345'; $env:TELEGRAM_API_HASH='xxxxxxxx'; py scripts/telegram-login.py
   Bash:
     TELEGRAM_API_ID=12345 TELEGRAM_API_HASH=xxxxxxxx py scripts/telegram-login.py

It will prompt for your phone number (international format, e.g. +9198...) and
the login code Telegram sends to that account. If the account has 2FA enabled it
also asks for the password. On success it prints the session string.
"""
import os
import sys

try:
    from telethon.sync import TelegramClient
    from telethon.sessions import StringSession
except ModuleNotFoundError:
    sys.exit("Telethon is not installed. Run:  py -m pip install telethon")

api_id_raw = os.environ.get("TELEGRAM_API_ID")
api_hash = os.environ.get("TELEGRAM_API_HASH")
if not api_id_raw or not api_hash:
    sys.exit(
        "Set TELEGRAM_API_ID and TELEGRAM_API_HASH first (from https://my.telegram.org)."
    )

try:
    api_id = int(api_id_raw)
except ValueError:
    sys.exit(f"TELEGRAM_API_ID must be an integer, got: {api_id_raw!r}")

# StringSession() with no argument = fresh, in-memory session. The interactive
# .start() (via the context manager) drives the phone/code/2FA prompts.
with TelegramClient(StringSession(), api_id, api_hash) as client:
    me = client.get_me()
    print("\n=== Logged in as:", getattr(me, "username", None) or me.first_name, "===")
    print("\nYour TELEGRAM_SESSION string (store it securely — full account access):\n")
    print(client.session.save())
    print(
        "\nNext: set it as the listener's TELEGRAM_SESSION env var (encrypted at rest).\n"
        "Do NOT commit it. If it leaks, revoke it from Telegram > Settings > Devices."
    )
