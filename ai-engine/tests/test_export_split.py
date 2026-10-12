import math
import random
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
import pytest

from src.corpus import export, split
from src.scorer import features_fs1

IST = timezone(timedelta(hours=5, minutes=30))
T0 = datetime(2026, 5, 4, 4, 0, tzinfo=timezone.utc)  # Monday 09:30 IST


def _record(i, day, group=None, win=True, taken=True, minute=0, source_id=None, outcome=True):
    at = T0 + timedelta(days=day, minutes=minute)
    feats, _ = features_fs1.extract({"checks": [{"name": "RSI on 5m", "passed": True, "detail": {"rsi": 50 + i % 10}}]},
                                    {"decided_at": at, "direction": "LONG", "strategy": "gated",
                                     "vix_regime": "NORMAL", "initial_price": 100.0})
    return {
        "id": f"id{i}", "source": "legacy:td_automation", "sourceId": source_id or f"watch_entries:{i:05d}",
        "kind": "ENTRY_SETUP", "decidedAt": at, "symbol": f"S{i}", "strategyKey": "legacy.gated",
        "direction": "LONG", "setupGroupKey": group or f"g{i}", "featureSet": features_fs1.FEATURE_SET,
        "features": feats, "ruleScore": 0.5, "decision": {"taken": taken},
        "outcome": ({"win": win, "rMultiple": 1.0 if win else -1.0, "rDerived": True} if outcome else None),
    }


def test_frame_shape_and_label_filter():
    recs = [_record(0, 0), _record(1, 0, outcome=False), _record(2, 1, taken=False),
            {**_record(3, 1), "outcome": {"win": None, "mfe": 2.0}}]
    df = export.load_frame_from_records(recs)
    assert list(df.columns[: len(features_fs1.feature_names())]) == features_fs1.feature_names()
    for c in export.META_COLUMNS:
        assert c in df.columns
    assert list(df["id"]) == ["id0"]
    assert df.loc[0, "vix_regime"] == "normal"
    assert df.loc[0, "win"] == 1
    every = export.load_frame_from_records(recs, taken_only=False, require_label=False)
    assert len(every) == 4


def test_features_as_json_string_accepted():
    import json
    r = _record(0, 0)
    r["features"] = json.dumps(r["features"])
    r["outcome"] = json.dumps(r["outcome"])
    assert len(export.load_frame_from_records([r])) == 1


def test_export_csv_round_trip(tmp_path):
    df = export.load_frame_from_records([_record(i, i % 3) for i in range(6)])
    path = tmp_path / "out" / "corpus.csv"
    export.export_csv(df, path)
    back = export.read_csv(path)
    pd.testing.assert_frame_equal(df.reset_index(drop=True), back.reset_index(drop=True), check_dtype=False)


def test_dedupe_keeps_earliest_then_lowest_source_id():
    recs = [_record(0, 0, group="g", minute=5, source_id="b"), _record(1, 0, group="g", minute=1, source_id="z"),
            _record(2, 0, group="g", minute=1, source_id="a"), _record(3, 0, group="h")]
    df = split.dedupe_groups(export.load_frame_from_records(recs))
    assert len(df) == 2
    assert df.set_index("setup_group_key").loc["g", "source_id"] == "a"


def _random_frame(rng, n=120, days=15):
    recs = []
    for i in range(n):
        g = f"g{rng.randrange(n // 2)}"
        recs.append(_record(i, rng.randrange(days), group=g, minute=rng.randrange(300), win=rng.random() < .5))
    return export.load_frame_from_records(recs)


def test_split_holdout_after_train_and_groups_disjoint_property():
    rng = random.Random(11)
    for _ in range(50):
        df = _random_frame(rng)
        frac = rng.choice([0.1, 0.2, 0.3])
        train, hold = split.time_group_split(df, holdout_frac=frac)
        assert len(train) + len(hold) <= len(df)  # straddling groups are purged
        assert not (set(train["setup_group_key"]) & set(hold["setup_group_key"]))
        tdays, hdays = split.ist_days(train), split.ist_days(hold)
        if len(train) and len(hold):
            assert tdays.max() < hdays.min()
        n_days = split.ist_days(df).nunique()
        assert hdays.nunique() <= math.ceil(frac * n_days)


def test_split_after_dedupe_exact_days():
    df = split.dedupe_groups(export.load_frame_from_records([_record(i, i % 10) for i in range(100)]))
    train, hold = split.time_group_split(df, 0.2)
    assert len(train) + len(hold) == len(df)
    assert sorted(split.ist_days(hold).unique()) == sorted(split.ist_days(df).unique())[-2:]


def test_group_kfold_disjoint_by_group():
    df = split.dedupe_groups(_random_frame(random.Random(5), n=200))
    folds = split.group_kfold(df, k=5)
    assert len(folds) == 5
    keys = df["setup_group_key"].to_numpy()
    seen = set()
    for tr, va in folds:
        assert not (set(keys[tr]) & set(keys[va]))
        seen |= set(va)
    assert seen == set(range(len(df)))
