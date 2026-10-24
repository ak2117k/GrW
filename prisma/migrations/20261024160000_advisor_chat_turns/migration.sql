-- AI advisor multi-turn memory (2026-10-24). Expand-only: one new table.

-- CreateTable
CREATE TABLE "advisor_chat_turns" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "advisor_chat_turns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "advisor_chat_turns_user_id_created_at_idx" ON "advisor_chat_turns"("user_id", "created_at");
