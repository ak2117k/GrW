-- Telegram signal trader (stream X): owner toggle "paper trade when the account lacks funds". ADD only.
-- docs/superpowers/plans/2026-10-23-telegram-signals-contract.md
ALTER TABLE "user_settings" ADD COLUMN "signalPaperOnNoFunds" BOOLEAN NOT NULL DEFAULT true;
