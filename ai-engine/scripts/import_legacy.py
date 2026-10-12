"""Import legacy silo history into ai_decision_records (idempotent).

  python scripts/import_legacy.py --source td_automation|grw_prod --src-url <url> --dst-url <url|none>
                                  [--dry-run] [--tables gated,ungated,adaptive] [--sentinel]

--dry-run (or --dst-url none) maps every row and prints the counts without writing.
--sentinel additionally derives sentinel review records from the destination's ai_calls.
Prints the counts as JSON.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.corpus.db import connect  # noqa: E402
from src.corpus.importer import SOURCE_QUERIES, SOURCES, import_source  # noqa: E402
from src.corpus.sentinel_records import build_from_ai_calls  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", required=True, choices=sorted(SOURCES))
    ap.add_argument("--src-url", required=True)
    ap.add_argument("--dst-url", required=True, help="destination DB URL, or 'none' for a dry run")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--tables", default=",".join(SOURCE_QUERIES))
    ap.add_argument("--sentinel", action="store_true", help="also build sentinel records from dst ai_calls")
    args = ap.parse_args(argv)

    tables = [t.strip() for t in args.tables.split(",") if t.strip()]
    dry = args.dry_run or args.dst_url.lower() == "none"
    src = connect(args.src_url)
    dst = None if dry else connect(args.dst_url)
    try:
        counts = {"source": SOURCES[args.source], "dryRun": dry, **import_source(src, dst, args.source, tables)}
        if args.sentinel and dst is not None:
            counts["sentinel"] = build_from_ai_calls(dst)
    finally:
        src.close()
        if dst is not None:
            dst.close()
    print(json.dumps(counts, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
