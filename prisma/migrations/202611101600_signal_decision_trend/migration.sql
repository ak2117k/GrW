-- Trend tag on each signal decision (owner 2026-11-10): WITH / AGAINST / MIXED / UNKNOWN the underlying's
-- 15m EMA20/EMA80 + MACD histogram, with the raw numbers. Record only (domain/trend-tag). Expand-only.
ALTER TABLE "signal_decisions" ADD COLUMN IF NOT EXISTS "trend" JSONB;
