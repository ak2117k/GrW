-- MBM relative reading + tick-built 1m bars. Expand-only: nullable columns, nothing altered or dropped.
-- mbm_predictions: the prediction's median range vs the last 10 sessions' realised range at the same
-- minute (rel_ratio = q50_bp / ref_range_bp; rel_label QUIETER | NORMAL | BUSIER | MUCH_BUSIER).
-- Rows written before this migration keep NULLs. grw_ai's table-level grants cover the new columns.
ALTER TABLE "mbm_predictions" ADD COLUMN "rel_ratio" DOUBLE PRECISION;
ALTER TABLE "mbm_predictions" ADD COLUMN "rel_label" TEXT;
ALTER TABLE "mbm_predictions" ADD COLUMN "ref_range_bp" DOUBLE PRECISION;

-- mbm_bars_1m: NULL = broker historical bar; 'tick' = a complete minute built from live ticks while the
-- historical fetch was throttled. The historical upsert resets it to NULL when it overwrites the bar.
ALTER TABLE "mbm_bars_1m" ADD COLUMN "source" TEXT;
