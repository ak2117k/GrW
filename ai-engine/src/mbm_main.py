"""MBM serving app (`uvicorn src.mbm_main:app --port 5100 --workers 1`). Observe only.

Env: MBM_INSTRUMENTS (default NIFTY), MODELS_DIR (default /models), AI_DB_* parts or
AI_DB_URL (see src/scorer/db_url.py), MBM_LOOP=off disables the loop (tests/local).
Never imports src/main.py or sklearn.
"""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI

from src.mbm.service import clock
from src.mbm.service.daily import fetch_global_daily
from src.mbm.service.engine import Engine
from src.mbm.service.setups import fetch_nsei_daily
from src.mbm.service.repo import PgRepo
from src.scorer.db_url import ai_db_url

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("mbm")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def make_engine(env=os.environ) -> Engine:
    url = ai_db_url(env)
    instruments = [s.strip().upper() for s in (env.get("MBM_INSTRUMENTS") or "NIFTY").split(",") if s.strip()]
    return Engine(repo=PgRepo(url) if url else None, models_dir=Path(env.get("MODELS_DIR") or "/models"),
                  instruments=instruments, now=utcnow, fetch_daily=fetch_global_daily,
                  fetch_index_daily=fetch_nsei_daily)


async def run_loop(engine: Engine) -> None:
    """Sleep to the next tick (run time, 08:30 daily refresh or 15:50 daily setups), then do it on a thread."""
    while True:
        now = engine.now()
        nxt_run, nxt_daily = clock.next_run(now), clock.next_daily_refresh(now)
        nxt_setups = clock.next_daily_setups(now)
        wake = min(nxt_run, nxt_daily, nxt_setups)
        await asyncio.sleep(max(0.0, (wake - now).total_seconds()))
        try:
            if wake == nxt_setups and wake < nxt_run:
                res = await asyncio.to_thread(engine.run_daily_setups)
                log.info("[mbm] daily setups: %s", res)
            elif wake == nxt_daily and wake < nxt_run:
                await asyncio.to_thread(engine.refresh_daily)
            else:
                res = await asyncio.to_thread(engine.run_once)
                log.info("[mbm] run %s: %s", clock.to_ist(wake).strftime("%H:%M:%S"), res)
        except Exception as exc:  # the loop must never die
            log.exception("[mbm] tick failed: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    engine: Engine = app.state.engine
    await asyncio.to_thread(engine.load_models)
    log.info("[mbm] instruments=%s models=%s db=%s", engine.instruments, engine.model_summary(),
             "on" if engine.repo else "off")
    task = None
    if (os.environ.get("MBM_LOOP") or "on").lower() != "off":
        await asyncio.to_thread(engine.refresh_daily)
        task = asyncio.create_task(run_loop(engine))
    try:
        yield
    finally:
        if task:
            task.cancel()


def create_app(engine: Engine | None = None) -> FastAPI:
    app = FastAPI(title="GrW MBM", lifespan=lifespan)
    app.state.engine = engine or make_engine()

    @app.get("/health")
    def health():
        return app.state.engine.health()

    @app.get("/behaviour/{instrument}")
    def behaviour(instrument: str):
        return app.state.engine.behaviour(instrument)

    return app


app = create_app()
