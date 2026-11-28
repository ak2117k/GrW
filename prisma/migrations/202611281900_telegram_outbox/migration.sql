-- Telegram outbox (2026-11-28, apps/api/src/common/utils/telegram-outbox.ts). Expand-only: one new table, nothing altered or dropped.
CREATE TABLE "telegram_outbox" (
    "id" TEXT NOT NULL,
    "sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "error" TEXT,
    "telegram_message_id" INTEGER,
    CONSTRAINT "telegram_outbox_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "telegram_outbox_sent_at_idx" ON "telegram_outbox"("sent_at");
