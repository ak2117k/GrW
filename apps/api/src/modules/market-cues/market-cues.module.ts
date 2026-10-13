import { Module } from '@nestjs/common';
import { MarketCuesService } from './market-cues.service';

/**
 * Market cues — US closes and index futures, MCX commodity benchmarks (WTI,
 * Brent, gold, silver, natural gas, copper) and USD/INR, FII/DII cash flows,
 * FII index F&O positioning, GIFT Nifty and the NSE pre-open book.
 *
 * LICENSING: every source here is a free, unofficial public endpoint (Yahoo,
 * CNBC, NSE, NSE IX, NSDL). That is acceptable for the OWNER'S OWN shadow
 * sentinel only. Surfacing these values to SaaS tenants — in a UI, an API or a
 * tenant-facing verdict — needs a licensed market-data vendor first.
 *
 * Off by default (`MARKET_CUES_ENABLED`). No imports: it reaches no broker, no
 * feed and no database — only HTTP to the sources above.
 */
@Module({
  providers: [MarketCuesService],
  exports: [MarketCuesService],
})
export class MarketCuesModule {}
