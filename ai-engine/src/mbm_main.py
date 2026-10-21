"""MBM serving app (`uvicorn src.mbm_main:app --port 5100 --workers 1`). Observe only.

Env: MBM_INSTRUMENTS (default NIFTY), MODELS_DIR (default /models), AI_DB_* parts or
AI_DB_URL (see src/scorer/db_url.py), MBM_LOOP=off disables the loop (tests/local).
Stock big-move nightly (SHADOW): STOCK_MOVE_ENABLED=observe|off (default observe), STOCK_MOVE_CACHE
(default /cache/stock-move; a writable volume). Runs on its own task, never inside the 5-min loop.
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
from src.mbm.stock_move.job import StockMoveJob, mode_from
from src.mbm.stock_move.repo import PgStockMoveRepo
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


def make_stock_move_job(env=os.environ) -> StockMoveJob:
    url = ai_db_url(env)
    return StockMoveJob(repo=PgStockMoveRepo(url) if url else None,
                        models_dir=Path(env.get("MODELS_DIR") or "/models"),
                        cache_dir=Path(env.get("STOCK_MOVE_CACHE") or "/cache/stock-move"),
                        now=utcnow, mode=mode_from(env))


async def stock_move_loop(job: StockMoveJob) -> None:
    """Catch-up on boot if the latest expected session has no rows, then weekdays 20:15 IST. Each run is
    a thread of its own: minutes of Yahoo pacing never delay the Model A ticks."""
    try:
        if await asyncio.to_thread(job.needs_catch_up):
            log.info("[stock-move] catch-up run on boot")
            await asyncio.to_thread(job.run)
    except Exception as exc:
        log.exception("[stock-move] catch-up failed: %s", exc)
    while True:
        now = job.now()
        wake = clock.next_stock_move(now)
        await asyncio.sleep(max(0.0, (wake - now).total_seconds()))
        try:
            await asyncio.to_thread(job.run)
        except Exception as exc:  # the loop must never die
            log.exception("[stock-move] nightly failed: %s", exc)


async def run_loop(engine: Engine) -> None:
    """Sleep to the next tick (run time, 08:30 daily refresh, 15:45 demotion check or 15:50 daily
    setups), then do it on a thread."""
    while True:
        now = engine.now()
        nxt_run, nxt_daily = clock.next_run(now), clock.next_daily_refresh(now)
        nxt_demote, nxt_setups = clock.next_demotion_check(now), clock.next_daily_setups(now)
        wake = min(nxt_run, nxt_daily, nxt_demote, nxt_setups)
        await asyncio.sleep(max(0.0, (wake - now).total_seconds()))
        try:
            if wake == nxt_demote and wake < nxt_run:
                await asyncio.to_thread(engine.check_demotions)
            elif wake == nxt_setups and wake < nxt_run:
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
    tasks = []
    if (os.environ.get("MBM_LOOP") or "on").lower() != "off":
        await asyncio.to_thread(engine.refresh_daily)
        tasks.append(asyncio.create_task(run_loop(engine)))
        job = getattr(app.state, "stock_move", None)
        if job is not None and job.mode != "off":
            tasks.append(asyncio.create_task(stock_move_loop(job)))
    try:
        yield
    finally:
        for t in tasks:
            t.cancel()


def create_app(engine: Engine | None = None, stock_move: StockMoveJob | None = None) -> FastAPI:
    app = FastAPI(title="GrW MBM", lifespan=lifespan)
    app.state.engine = engine or make_engine()
    app.state.stock_move = stock_move if stock_move is not None or engine is not None else make_stock_move_job()

    @app.get("/health")
    def health():
        h = app.state.engine.health()
        job = app.state.stock_move
        if job is not None:
            h["stockMove"] = {"mode": job.mode, "last": job.last_summary or None}
        return h

    @app.get("/behaviour/{instrument}")
    def behaviour(instrument: str):
        return app.state.engine.behaviour(instrument)

    return app


app = create_app()
