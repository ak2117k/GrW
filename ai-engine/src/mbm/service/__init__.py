"""MBM M2 serving: the live Model A loop, outcome filler and `/behaviour` endpoint backing.

Observe only. Features come from `src.mbm.features.build_features` unchanged (the training
code path) fed with frames built from `mbm_bars_1m` rows; labels/outcomes reuse
`src.mbm.labels`.
"""
