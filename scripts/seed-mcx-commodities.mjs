// Seed MCX commodity instrument rows so backfill + live ingestion can persist
// candles for them. CRUDEOIL and COPPER are the two we trade today; tokens
// come from packages/shared/src/constants/index.ts and reflect the current
// front-month FUTCOM contracts.
//
// Why this exists: MarketFeedService auto-subscribes COMMODITIES tokens to
// the live feed, but ticks get dropped at persistence because the candle
// aggregator looks up instrumentId via tokenInstrumentMap, which is empty
// without a corresponding `instruments` row. This script creates those rows.
//
// Re-run safely — uses upsert on (symbol, exchange, token).
//
// Usage:
//   node scripts/seed-mcx-commodities.mjs

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const COMMODITIES = [
  {
    symbol: 'CRUDEOIL',
    name: 'CRUDEOIL',
    token: '486502',
    exchange: 'MCX',
    segment: 'COMMODITY',
    lotSize: 100,
    tickSize: 1,
  },
  {
    symbol: 'COPPER',
    name: 'COPPER',
    token: '488791',
    exchange: 'MCX',
    segment: 'COMMODITY',
    lotSize: 2500,
    tickSize: 0.05,
  },
];

async function main() {
  console.log('=== Seeding MCX commodity instruments ===');
  for (const c of COMMODITIES) {
    const row = await prisma.instrument.upsert({
      where: {
        symbol_exchange_token: {
          symbol: c.symbol,
          exchange: c.exchange,
          token: c.token,
        },
      },
      create: {
        symbol: c.symbol,
        name: c.name,
        token: c.token,
        exchange: c.exchange,
        segment: c.segment,
        lotSize: c.lotSize,
        tickSize: c.tickSize,
        isActive: true,
      },
      update: { isActive: true, lotSize: c.lotSize, segment: c.segment },
    });
    console.log(`  ${c.symbol} (token ${c.token}) → instrumentId ${row.id}`);
  }
  console.log('=== Done ===');
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
