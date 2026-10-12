"""Leakage-safe splits: one row per setup group, time-ordered holdout, grouped CV folds."""
from __future__ import annotations

import math

import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold

IST = "Asia/Kolkata"


def ist_days(df: pd.DataFrame) -> pd.Series:
    return pd.to_datetime(df["decided_at"], utc=True).dt.tz_convert(IST).dt.date


def dedupe_groups(df: pd.DataFrame) -> pd.DataFrame:
    """One row per ``setup_group_key``: the earliest ``decided_at``; ties → lowest ``source_id``."""
    if df.empty:
        return df.copy()
    ordered = df.sort_values(["setup_group_key", "decided_at", "source_id"], kind="mergesort")
    return ordered.drop_duplicates("setup_group_key", keep="first").sort_values(
        ["decided_at", "source_id"], kind="mergesort").reset_index(drop=True)


def time_group_split(df: pd.DataFrame, holdout_frac: float = 0.2) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Holdout = groups whose IST trading days all fall in the last ceil(frac * n_days) days.

    A group with rows on both sides of the cutoff (impossible after ``dedupe_groups``, whose legacy
    keys embed the date) is purged from both sides, so no group is shared and every holdout day is
    strictly after every train day.
    """
    if df.empty:
        return df.copy(), df.copy()
    days = ist_days(df)
    unique_days = sorted(days.unique())
    n_hold = min(len(unique_days), max(0, math.ceil(holdout_frac * len(unique_days))))
    if n_hold == 0:
        return df.reset_index(drop=True), df.iloc[0:0].copy()
    cutoff = unique_days[-n_hold]
    keys = df["setup_group_key"].to_numpy()
    first = days.groupby(keys).transform("min").to_numpy()
    last = days.groupby(keys).transform("max").to_numpy()
    is_hold = first >= cutoff
    is_train = last < cutoff
    return df[is_train].reset_index(drop=True), df[is_hold].reset_index(drop=True)


def group_kfold(df: pd.DataFrame, k: int = 5) -> list[tuple[np.ndarray, np.ndarray]]:
    groups = df["setup_group_key"].to_numpy()
    n_splits = min(k, len(set(groups)))
    if n_splits < 2:
        return []
    return list(GroupKFold(n_splits=n_splits).split(np.zeros(len(df)), groups=groups))
