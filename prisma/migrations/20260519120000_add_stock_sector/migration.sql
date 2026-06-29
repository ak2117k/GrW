-- CreateTable: stock_sectors
-- Broad stock → NSE sector-index mapping. Populated daily by
-- NseSectorIndexService from the NIFTY 500 constituent CSV. Replaces the
-- large-cap-biased in-memory map so mid/small-caps resolve to a sector
-- index too. `sectorIndexToken` is nullable for industries with no clean
-- NIFTY sector index (the lookup returns null for those, by design).

CREATE TABLE "stock_sectors" (
    "symbol" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "sectorIndexToken" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_sectors_pkey" PRIMARY KEY ("symbol")
);

-- CreateIndex
CREATE INDEX "stock_sectors_sectorIndexToken_idx" ON "stock_sectors"("sectorIndexToken");
