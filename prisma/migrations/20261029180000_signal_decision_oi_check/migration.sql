-- OI check on each paper open (owner 2026-10-29): AGREES / AGAINST / MIXED / NO_DATA + the numbers. Record only.
ALTER TABLE "signal_decisions" ADD COLUMN "oi_check" JSONB;
