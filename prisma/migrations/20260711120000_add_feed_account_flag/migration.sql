-- Vault -> market-feed bridge: designate ONE account whose vault credentials
-- power the shared market-data feed.
ALTER TABLE "users" ADD COLUMN "isFeedAccount" BOOLEAN NOT NULL DEFAULT false;

-- Enforce at most one feed account at a time. A partial unique index only
-- constrains rows where the flag is true, so any number of rows may be false.
CREATE UNIQUE INDEX "users_isFeedAccount_key" ON "users" ("isFeedAccount") WHERE "isFeedAccount" = true;
