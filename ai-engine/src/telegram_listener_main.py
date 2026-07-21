"""Entry point for the standalone Telegram listener (single-machine deployment).

Run from the ai-engine/ directory:
    py -m src.telegram_listener_main

Loads env vars from ai-engine/.env if present (copy .env.listener.example → .env).
Requires: `telethon` and `claude-agent-sdk` installed, and the host logged into
Claude Code — the parser runs in-process via the Claude Agent SDK on your
subscription login (no ANTHROPIC_API_KEY needed).
"""
import asyncio
import logging

try:
    from dotenv import load_dotenv

    load_dotenv()  # loads ./.env when run from ai-engine/
except ModuleNotFoundError:  # dotenv is optional — env can be set in the shell
    pass

from src.services.telegram_listener import TelegramListener

if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logging.getLogger("telegram_listener").info("Starting Telegram listener…")
    asyncio.run(TelegramListener().run())
