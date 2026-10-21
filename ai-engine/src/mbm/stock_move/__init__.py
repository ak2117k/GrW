"""Stock big-move model (SHADOW): pooled daily LightGBM over the F&O stocks.

Target `y_big5_1.5`: |5-session forward return| > 1.5 x ATR%(14) x sqrt(5). Direction is NOT predicted.
Ported from `grw-mbm/research/stock-daily` (build.py, parse_earnings.py, earnings_feats.py, run_er.py `wf er0`).
Contract: docs/superpowers/plans/2026-10-22-stock-move-contract.md.
"""
KIND = "stock-move"
FEATURE_SET = "sm-daily-er0"
TARGET = "y_big5_1.5"
HORIZON_DAYS = 5
THRESHOLD_ATR = 1.5
