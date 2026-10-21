"""Dry-run: score ONE date locally with a stock-move artefact (no DB, no network, nothing written).

  py -3 scripts/stock_move_score.py --as-of 2026-10-21
  py -3 scripts/stock_move_score.py --as-of 2026-10-21 --model-dir ~/grw-mbm/models/stock-move/20261022 --top 15 --json out.json

Prices: the PC CSV cache filled by `stock_move_ship.py fetch-prices` (same reader the service uses).
Calendar: the artefact's seed (+ --calendar-dir, e.g. a copy of the service's /cache/stock-move/calendar).
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.mbm.stock_move.job import dry_run  # noqa: E402
from src.mbm.store import default_root  # noqa: E402


def newest_model(root: Path) -> Path | None:
    dirs = sorted(d for d in root.glob("[0-9]" * 8) if (d / "model.txt").is_file())
    return dirs[-1] if dirs else None


def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
    p = argparse.ArgumentParser(prog="stock_move_score", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--as-of", required=True, type=date.fromisoformat)
    p.add_argument("--model-dir", type=Path)
    p.add_argument("--prices-dir", type=Path, default=default_root() / "stock-move" / "prices")
    p.add_argument("--calendar-dir", type=Path)
    p.add_argument("--symbols", nargs="+", help="default: the model's training universe")
    p.add_argument("--top", type=int, default=10)
    p.add_argument("--json", type=Path, help="write all rows here")
    a = p.parse_args(argv)
    md = a.model_dir or newest_model(default_root() / "models" / "stock-move")
    if md is None or not (md / "model.txt").is_file():
        print("no artefact: pass --model-dir or run stock_move_ship.py train")
        return 2
    rows, st = dry_run(md, a.prices_dir, a.as_of, a.symbols, a.calendar_dir)
    if not rows:
        print(f"nothing scored for {a.as_of} (priced {st.get('priced')}, stale {len(st.get('stale', []))})")
        return 1
    rows.sort(key=lambda r: -r["rank_pct"])
    print(f"{a.as_of}: scored {len(rows)} (stale {len(st['stale'])}) with {md.name}; "
          f"TOP20 {sum(r['bucket'] == 'TOP20' for r in rows)}, results in window {sum(r['results_in_window'] for r in rows)}")
    show = rows[:a.top] + [None] + rows[-a.top:]
    for r in show:
        if r is None:
            print("  …")
            continue
        drv = ", ".join(d["f"] for d in r["features"]["drivers"])
        res = f"results {r['results_date']}" + (" in window" if r["results_in_window"] else "") if r["results_date"] else ""
        print(f"  {r['symbol']:<12} p(big 5d) {r['p_big']:.3f}  rank {r['rank_pct']:.3f} {r['bucket']:<8} "
              f"atr {100 * (r['atr_pct'] or 0):.2f}%  {res:<28} [{drv}]")
    if a.json:
        a.json.write_text(json.dumps(rows, default=str, indent=1), encoding="utf-8")
        print(f"wrote {a.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
