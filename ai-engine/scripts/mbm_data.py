"""MBM training-store CLI: build, probe, pull-exports, import-exports, status.

  python ai-engine/scripts/mbm_data.py build --vps root@<vps-ip> --ssh-key ~/.ssh/grw_oracle
  python ai-engine/scripts/mbm_data.py probe --db-url postgresql://...   (local DB only)
  python ai-engine/scripts/mbm_data.py status

Exit codes: 0 ok · 1 a chunk/series/export failed (named in the summary) · 2 refused
(market hours) or bad usage.
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.mbm import backfill, exports  # noqa: E402
from src.mbm.angel import AngelError, AngelHistory, MarketHoursError, assert_off_market_hours, load_angel_env  # noqa: E402
from src.mbm.probe import expired_candidates, probe_depth, probe_expired, write_probe_report  # noqa: E402
from src.mbm.scrip_master import load_master  # noqa: E402
from src.mbm.store import default_root, load_manifest  # noqa: E402
from src.mbm.universe import load_universe, resolve_series  # noqa: E402
from src.mbm.yahoo import YAHOO_INTERVALS  # noqa: E402

REPO = ROOT.parent


def _now() -> datetime:
    return datetime.now(timezone.utc)


def cmd_build(a) -> int:
    return backfill.build(a.store, a.env, a.instrument, _now(), a.allow_market_hours, a.vps,
                          a.ssh_key, run_probes=True)


def cmd_probe(a) -> int:
    now = _now()
    try:
        assert_off_market_hours(now, a.allow_market_hours)
        angel = AngelHistory(load_angel_env(a.env))
        angel.login()
    except MarketHoursError as exc:
        print(f"refused: {exc}")
        return 2
    except AngelError as exc:
        print(f"Angel login failed: {exc}")
        return 1
    today = now.astimezone(backfill.IST).date()
    meta = a.store / "_meta"
    master = load_master(meta, today)
    specs = resolve_series(load_universe(), a.instrument, master, today)
    depth = backfill.run_depth_probes(a.store, specs, angel, today, force=True)
    import time
    for s in [s for s in specs if s.source == "yahoo"]:
        for iv in YAHOO_INTERVALS:
            depth.append(probe_depth(s.id, iv, backfill._yahoo_has_data(s.symbol, iv, None, time.sleep),
                                     today, max_years=30 if iv == "1d" else 3))
    names = ["NIFTY"] + [f["name"] for f in load_universe()[a.instrument].get("probe_only_futures", [])]
    cands = expired_candidates(meta, names, today, extra_csv=a.expired_tokens, db_url=a.db_url)
    expired = probe_expired(angel, cands)
    md = write_probe_report(meta, depth, expired, today)
    print(md.read_text(encoding="utf-8"))
    return 1 if any(d.status == "unknown" for d in depth) or any(e.status == "error" for e in expired) else 0


def cmd_pull(a) -> int:
    if not a.vps or not a.ssh_key:
        print("pull-exports needs --vps and --ssh-key (or MBM_VPS / MBM_SSH_KEY)")
        return 2
    got = exports.pull_exports(a.vps, a.ssh_key, a.store / "exports_raw")
    print(f"pulled {len(got)} new files")
    return 0


def cmd_import(a) -> int:
    print(exports.import_exports(a.store / "exports_raw", a.store))
    return 0


def cmd_status(a) -> int:
    m = load_manifest(a.store)
    print(f"store: {a.store}")
    print(f"{'series':<22} {'iv':<4} {'rows':>9} {'first':<26} {'last':<26} {'depth':<11} failed")
    for sid in sorted(m):
        for iv, e in sorted(m[sid].items()):
            print(f"{sid:<22} {iv:<4} {str(e.get('rows', '-')):>9} {str(e.get('first') or '-'):<26} "
                  f"{str(e.get('last') or '-'):<26} {str(e.get('depth_earliest') or e.get('depth_status') or '-'):<11} "
                  f"{len(e.get('failed_chunks') or [])}")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="mbm_data", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--store", type=Path, default=default_root())
    common.add_argument("--env", type=Path, default=REPO / "apps" / "api" / ".env")
    common.add_argument("--instrument", default="NIFTY")
    common.add_argument("--allow-market-hours", action="store_true")
    common.add_argument("--vps", default=os.environ.get("MBM_VPS"))
    common.add_argument("--ssh-key", type=Path,
                        default=Path(os.path.expanduser(os.environ["MBM_SSH_KEY"])) if os.environ.get("MBM_SSH_KEY") else None)
    sub.add_parser("build", parents=[common], help="probe depth if needed, backfill all series, pull exports")
    pr = sub.add_parser("probe", parents=[common], help="history depth + expired-futures probe report")
    pr.add_argument("--expired-tokens", type=Path, help="CSV symbol,token,exch_seg,expiry")
    pr.add_argument("--db-url", help="read-only local TD_Automation DB for old contract tokens (never prod)")
    sub.add_parser("pull-exports", parents=[common], help="scp new prod export files to the store")
    sub.add_parser("import-exports", parents=[common], help="fold raw export CSVs into parquet")
    sub.add_parser("status", parents=[common], help="manifest as a table")
    a = p.parse_args(argv)
    if a.ssh_key:
        a.ssh_key = Path(os.path.expanduser(str(a.ssh_key)))
    return {"build": cmd_build, "probe": cmd_probe, "pull-exports": cmd_pull,
            "import-exports": cmd_import, "status": cmd_status}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
