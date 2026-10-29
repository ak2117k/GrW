-- OI capture widening (2026-10-29): the contract's last traded price (rupees) from the SAME quote call
-- that read its OI, so price change + OI change (long/short build-up) come from one row. NULL = the
-- quote carried no LTP, and for every row written before this migration. Nullable with no default:
-- a metadata-only change, no table rewrite.
ALTER TABLE "oi_snapshots" ADD COLUMN "ltp" DOUBLE PRECISION;
