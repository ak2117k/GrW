"""Train the XGBoost entry scorer from the decision corpus, apply the go/no-go gate, write a report.

  python scripts/train_entry_scorer.py (--db-url <url> | --records-jsonl <path>) --models-dir <dir>
                                       [--activate] [--report-dir docs/sp3] [--export-csv <path>]

--db-url reads ai_decision_records and registers the model in ai_models (inactive unless --activate,
which is refused for a NO_GO model). --records-jsonl trains from exported records without any DB.
Prints the result JSON.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.corpus.export import export_csv, load_frame, load_frame_from_records  # noqa: E402
from src.scorer import features_fs1, registry, train  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--db-url")
    src.add_argument("--records-jsonl", type=Path)
    ap.add_argument("--models-dir", type=Path, required=True)
    ap.add_argument("--activate", action="store_true")
    ap.add_argument("--report-dir", type=Path, default=ROOT.parent / "docs" / "sp3")
    ap.add_argument("--export-csv", type=Path)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args(argv)
    if args.activate and not args.db_url:
        ap.error("--activate needs --db-url")

    conn = None
    if args.db_url:
        from src.corpus.db import connect
        conn = connect(args.db_url)
        df = load_frame(conn, features_fs1.FEATURE_SET)
        source = "ai_decision_records (database)"
    else:
        lines = args.records_jsonl.read_text(encoding="utf-8").splitlines()
        df = load_frame_from_records([json.loads(x) for x in lines if x.strip()])
        source = f"records file {args.records_jsonl.name}"
    try:
        if args.export_csv:
            export_csv(df, args.export_csv)
        result = train.train(df, seed=args.seed)
        path = registry.save_artifact(result.artifact, args.models_dir, result.model_id)
        if conn is not None:
            registry.register(conn, result, path, activate=args.activate)
    finally:
        if conn is not None:
            conn.close()

    counts = {
        "rows by source": ", ".join(f"{k}={v}" for k, v in df["source"].value_counts().sort_index().items()),
        "rows by strategy": ", ".join(f"{k}={v}" for k, v in df["strategy_key"].value_counts().sort_index().items()),
    }
    args.report_dir.mkdir(parents=True, exist_ok=True)
    report = args.report_dir / f"training-report-{datetime.now(timezone.utc).strftime('%Y-%m-%d')}.md"
    report.write_text(train.render_report(result, source=source, counts=counts), encoding="utf-8")
    out = train.result_json(result) | {"artifact": str(path), "report": str(report)}
    print(json.dumps(out, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
