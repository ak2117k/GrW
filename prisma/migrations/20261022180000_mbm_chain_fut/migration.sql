-- MBM chain capture: the nearest-month index future LTP beside spot (basis = fut - spot). Expand-only:
-- one nullable column, nothing altered or dropped; rows captured before this migration keep fut NULL.

-- AlterTable
ALTER TABLE "mbm_chain_snapshots" ADD COLUMN "fut" DOUBLE PRECISION;
