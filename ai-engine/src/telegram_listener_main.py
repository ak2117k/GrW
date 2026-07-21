"""Entrypoint for the Telethon listener: ``python -m src.telegram_listener_main``."""
import asyncio
import logging

from src.services.telegram_listener import TelegramListener

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(TelegramListener().run())
