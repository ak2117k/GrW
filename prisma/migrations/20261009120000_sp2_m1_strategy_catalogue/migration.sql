-- SP2 M1 — trade-core strategy catalogue
-- (docs/superpowers/specs/2026-10-09-sp2-core-trade-lifecycle-design.md §4.1–4.3).
--
-- Expand-only: creates three tables, CHECK constraints, an immutability trigger and
-- two seed rows. Drops and alters nothing that exists. core_strategy_docs and
-- core_strategy_gaps arrive with M6.

CREATE TABLE "core_strategies" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "allowedVehicles" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "core_strategies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "core_strategy_versions" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "blocks" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "sourceDocId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "core_strategy_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "core_strategy_selections" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "strategyVersionId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "capitalAllocation" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "core_strategy_selections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "core_strategies_key_key" ON "core_strategies"("key");
CREATE INDEX "core_strategy_versions_strategyId_status_idx" ON "core_strategy_versions"("strategyId", "status");
CREATE UNIQUE INDEX "core_strategy_versions_strategyId_version_key" ON "core_strategy_versions"("strategyId", "version");
CREATE INDEX "core_strategy_selections_strategyVersionId_idx" ON "core_strategy_selections"("strategyVersionId");
CREATE UNIQUE INDEX "core_strategy_selections_userId_strategyId_key" ON "core_strategy_selections"("userId", "strategyId");

ALTER TABLE "core_strategy_versions" ADD CONSTRAINT "core_strategy_versions_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "core_strategies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core_strategy_selections" ADD CONSTRAINT "core_strategy_selections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "core_strategy_selections" ADD CONSTRAINT "core_strategy_selections_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "core_strategies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core_strategy_selections" ADD CONSTRAINT "core_strategy_selections_strategyVersionId_fkey" FOREIGN KEY ("strategyVersionId") REFERENCES "core_strategy_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- String enums are pinned here (Prisma models them as String; its diff ignores CHECKs).
ALTER TABLE "core_strategies" ADD CONSTRAINT "core_strategies_allowedVehicles_check"
    CHECK ("allowedVehicles" IS NOT NULL AND cardinality("allowedVehicles") > 0 AND "allowedVehicles" <@ ARRAY['CASH_INTRADAY', 'MTF', 'OPTIONS_BUY']::TEXT[]);
ALTER TABLE "core_strategy_versions" ADD CONSTRAINT "core_strategy_versions_status_check"
    CHECK ("status" IN ('DRAFT', 'PAPER', 'LIVE', 'RETIRED'));
ALTER TABLE "core_strategy_versions" ADD CONSTRAINT "core_strategy_versions_createdBy_check"
    CHECK ("createdBy" IN ('OWNER', 'AI'));
ALTER TABLE "core_strategy_versions" ADD CONSTRAINT "core_strategy_versions_version_check"
    CHECK ("version" >= 1);
ALTER TABLE "core_strategy_selections" ADD CONSTRAINT "core_strategy_selections_capitalAllocation_check"
    CHECK ("capitalAllocation" >= 0 AND "capitalAllocation" < 'Infinity'::float8);

-- Immutable once approved (plan decision 8). A version that has left DRAFT keeps its
-- content and id forever; only its status may move on (PAPER → RETIRED), and
-- RETIRED is final. It is never
-- deleted, because positions reference the version they entered under (M4).
CREATE OR REPLACE FUNCTION core_strategy_versions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'core_strategy_versions %: an approved version cannot be deleted', OLD."id";
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" <> 'DRAFT' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."blocks" IS DISTINCT FROM OLD."blocks"
       OR NEW."strategyId" IS DISTINCT FROM OLD."strategyId"
       OR NEW."version" IS DISTINCT FROM OLD."version"
       OR NEW."createdBy" IS DISTINCT FROM OLD."createdBy"
       OR NEW."sourceDocId" IS DISTINCT FROM OLD."sourceDocId"
       OR NEW."notes" IS DISTINCT FROM OLD."notes"
       OR NEW."approvedBy" IS DISTINCT FROM OLD."approvedBy"
       OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt" THEN
      RAISE EXCEPTION 'core_strategy_versions %: an approved version is immutable; create version n+1', OLD."id";
    END IF;
    IF NEW."status" = 'DRAFT' THEN
      RAISE EXCEPTION 'core_strategy_versions %: an approved version cannot return to DRAFT', OLD."id";
    END IF;
    IF OLD."status" = 'RETIRED' AND NEW."status" <> 'RETIRED' THEN
      RAISE EXCEPTION 'core_strategy_versions %: a retired version cannot leave RETIRED; create version n+1', OLD."id";
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "core_strategy_versions_guard"
    BEFORE UPDATE OR DELETE ON "core_strategy_versions"
    FOR EACH ROW EXECUTE FUNCTION core_strategy_versions_guard();

-- SEED BEGIN
-- Seeds are data (spec §4.1), idempotent (ON CONFLICT DO NOTHING), inserted as DRAFT so
-- the owner approves each in the UI. Values are copied from the silo code at commit
-- 321af45; every number is cited in docs/superpowers/plans/2026-10-09-sp2-m1-strategy-catalogue.md
-- (decision 5) and checked against the silo source by core-strategy-seeds.spec.ts.
-- Each blocks literal stays on ONE line (the spec parses it). No statement contains a
-- semicolon followed by a newline inside a string (the opt-in test splits on that).
INSERT INTO "core_strategies" ("id", "key", "name", "description", "allowedVehicles", "createdAt") VALUES
    ('cs_adaptive_stop', 'adaptive-stop', 'Adaptive-Stop', 'Chartink alerts that pass the gated score and the decision gate, with an ATR volatility stop, risk-first sizing, a 50 percent partial at +1 percent and an ATR trail on the rest. Seeded from the adaptive-stop-track silo.', ARRAY['CASH_INTRADAY']::TEXT[], CURRENT_TIMESTAMP),
    ('cs_ungated', 'ungated', 'Ungated', 'Hull-scanner Chartink alerts with a fixed 1.5 percent stop and a 3 percent target, held to target, stop or close. Seeded from the ungated-track silo.', ARRAY['CASH_INTRADAY']::TEXT[], CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "core_strategy_versions" ("id", "strategyId", "version", "blocks", "status", "createdBy", "notes", "createdAt", "updatedAt")
SELECT 'csv_adaptive_stop_v1', s."id", 1, '{"entry":{"kind":"chartink","scanName":null,"match":"ANY","side":"BUY","minScore":{"base":47,"windows":[{"fromHhmm":"11:45","toHhmm":"14:00","score":75}]}},"filters":{"staleEntry":{"maxMovePct":1},"cooldown":{"minutes":45},"lastLoss":{"window":"SAME_IST_DAY"},"gates":[{"kind":"evaluator","evaluatorKey":"adaptive-stop-decision-gate","params":{"nearSupportPct":0.6,"rsiHot":70,"vwapExtPct":1.5,"requireMacdBullish":true,"srLookbackDays":5,"minCandles":10,"minSameDayCandles":3,"failOpen":true}}]},"stop":{"kind":"atr","period":14,"timeframe":"5m","multiple":1.2,"minPct":0.8,"maxPct":2.5},"target":{"kind":"fixedPct","pct":2},"trail":{"kind":"atr","multiple":1,"minPct":0.6,"maxPct":1.5,"startsAfter":"PARTIAL"},"timeExit":{"kind":"clock","hhmm":"15:15"},"partial":{"kind":"atTarget1","fraction":0.5,"atPct":1},"sizing":{"kind":"riskRupees","amount":800},"vehicle":{"kind":"CASH_INTRADAY"}}'::jsonb, 'DRAFT', 'OWNER', 'Seeded 2026-10-09 from the adaptive-stop-track silo (commit 321af45). Dropped by owner decision 2026-10-09 (artifacts of 30-second polling, not carried into the core): two-strike stop confirmation (adaptive-stop-watch.service.ts:383-397) and the 2-minute stop grace (constants.ts:12). Left to the Risk Wall (M2): one open position per symbol (adaptive-stop-watch.service.ts:171-172) and 40 concurrent positions (constants.ts:4). Evaluator plumbing, not a rule: decision-gate 15m fetch retries (constants.ts:41-42). ATR source: 3 days of 5m candles, at least 21 (adaptive-stop-watch.service.ts:110-112).', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "core_strategies" s WHERE s."key" = 'adaptive-stop'
ON CONFLICT ("strategyId", "version") DO NOTHING;

INSERT INTO "core_strategy_versions" ("id", "strategyId", "version", "blocks", "status", "createdBy", "notes", "createdAt", "updatedAt")
SELECT 'csv_ungated_v1', s."id", 1, '{"entry":{"kind":"chartink","scanName":"hull","match":"CONTAINS","side":"BUY","minScore":null},"filters":{"staleEntry":{"maxMovePct":1},"cooldown":{"minutes":45},"lastLoss":{"window":"SAME_IST_DAY"},"gates":[]},"stop":{"kind":"fixedPct","pct":1.5},"target":{"kind":"fixedPct","pct":3},"trail":{"kind":"none"},"timeExit":{"kind":"clock","hhmm":"15:25"},"partial":{"kind":"none"},"sizing":{"kind":"notionalRupees","amount":200000},"vehicle":{"kind":"CASH_INTRADAY"}}'::jsonb, 'DRAFT', 'OWNER', 'Seeded 2026-10-09 from the ungated-track silo (commit 321af45). Dropped by owner decision 2026-10-09 (an artifact of 30-second polling): two-strike stop confirmation (ungated-watch.service.ts:288-296). Left to the Risk Wall (M2): one open position per symbol (ungated-watch.service.ts:113-114) and 40 concurrent positions (ungated-paper-account.service.ts:8). Not carried: the UNGATED_HULL_ONLY env switch (ungated-watch.service.ts:105; the version itself now says Hull-only) and the at-least-1-share floor (ungated-watch.service.ts:212; sizing below one share is a Risk Wall reject).', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "core_strategies" s WHERE s."key" = 'ungated'
ON CONFLICT ("strategyId", "version") DO NOTHING;
-- SEED END
