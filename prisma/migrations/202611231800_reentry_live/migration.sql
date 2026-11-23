-- Re-entry watch LIVE mode (2026-11-23, docs/superpowers/specs/2026-11-23-reentry-live-design.md §4.4, §6a.8).
-- Expand-only: nullable / defaulted columns and indexes, nothing altered or dropped.
--
-- reentry_watch_decisions: a live-mode SIGNAL row stores the limit that kept it off the broker (limit_hit, e.g.
-- MAX_PER_DAY; limit_detail, e.g. '6/6') and the signal_orders row of a live order (signal_order_id). No FK.
ALTER TABLE "reentry_watch_decisions" ADD COLUMN "limit_hit" TEXT;
ALTER TABLE "reentry_watch_decisions" ADD COLUMN "limit_detail" TEXT;
ALTER TABLE "reentry_watch_decisions" ADD COLUMN "signal_order_id" TEXT;
CREATE INDEX "reentry_watch_decisions_signal_order_id_idx" ON "reentry_watch_decisions"("signal_order_id");

-- signal_orders: who placed the order ('signal' = the signal trader, every existing row; 'reentry' = a live
-- re-entry) and, for a re-entry, the watch it belongs to ('<table>:<id>' of the original exit). The per-watch /
-- per-day caps and the "no chain" rule read these; the tracker is linked through the existing tracker_id.
ALTER TABLE "signal_orders" ADD COLUMN "source" TEXT DEFAULT 'signal';
ALTER TABLE "signal_orders" ADD COLUMN "reentry_watch_key" TEXT;
CREATE INDEX "signal_orders_reentry_watch_key_idx" ON "signal_orders"("reentry_watch_key");
CREATE INDEX "signal_orders_source_created_at_idx" ON "signal_orders"("source", "created_at");
