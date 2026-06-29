import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Seed instruments that the frontend expects to exist.
 * These are the major indices and popular equities hardcoded
 * in the watchlist, chart store, and market data hooks.
 *
 * In production, the full instrument master list is refreshed daily
 * from the Angel One API via InstrumentService.refreshMaster().
 */
const SEED_INSTRUMENTS = [
  // Major Indices
  { symbol: 'NIFTY', token: '99926000', name: 'Nifty 50', exchange: 'NSE', segment: 'INDICES', lotSize: 50, tickSize: 0.05 },
  { symbol: 'BANKNIFTY', token: '99926009', name: 'Bank Nifty', exchange: 'NSE', segment: 'INDICES', lotSize: 25, tickSize: 0.05 },
  { symbol: 'FINNIFTY', token: '99926037', name: 'Fin Nifty', exchange: 'NSE', segment: 'INDICES', lotSize: 40, tickSize: 0.05 },
  { symbol: 'SENSEX', token: '99919000', name: 'BSE Sensex', exchange: 'BSE', segment: 'INDICES', lotSize: 10, tickSize: 0.05 },
  { symbol: 'NIFTY MIDCAP 50', token: '99926025', name: 'Nifty Midcap 50', exchange: 'NSE', segment: 'INDICES', lotSize: 1, tickSize: 0.05 },
  { symbol: 'NIFTY IT', token: '99926013', name: 'Nifty IT', exchange: 'NSE', segment: 'INDICES', lotSize: 1, tickSize: 0.05 },

  // Popular Equities (from default watchlist)
  { symbol: 'RELIANCE', token: '2885', name: 'Reliance Industries', exchange: 'NSE', segment: 'EQ', lotSize: 1, tickSize: 0.05 },
  { symbol: 'TCS', token: '11536', name: 'Tata Consultancy Services', exchange: 'NSE', segment: 'EQ', lotSize: 1, tickSize: 0.05 },
  { symbol: 'HDFCBANK', token: '1333', name: 'HDFC Bank', exchange: 'NSE', segment: 'EQ', lotSize: 1, tickSize: 0.05 },
  { symbol: 'INFY', token: '1594', name: 'Infosys', exchange: 'NSE', segment: 'EQ', lotSize: 1, tickSize: 0.05 },
  { symbol: 'ICICIBANK', token: '4963', name: 'ICICI Bank', exchange: 'NSE', segment: 'EQ', lotSize: 1, tickSize: 0.05 },
  { symbol: 'SBIN', token: '3045', name: 'State Bank of India', exchange: 'NSE', segment: 'EQ', lotSize: 1, tickSize: 0.05 },
  { symbol: 'TATAMOTORS', token: '3456', name: 'Tata Motors', exchange: 'NSE', segment: 'EQ', lotSize: 1, tickSize: 0.05 },
  { symbol: 'ITC', token: '1660', name: 'ITC Ltd', exchange: 'NSE', segment: 'EQ', lotSize: 1, tickSize: 0.05 },
  { symbol: 'LT', token: '11483', name: 'Larsen & Toubro', exchange: 'NSE', segment: 'EQ', lotSize: 1, tickSize: 0.05 },
  { symbol: 'AXISBANK', token: '5900', name: 'Axis Bank', exchange: 'NSE', segment: 'EQ', lotSize: 1, tickSize: 0.05 },
];

async function main() {
  // ---- TDA-001: multi-tenant foundation seed (idempotent) ----
  console.log('Seeding multi-tenant foundation (ADMIN user + consent doc)...');

  await prisma.user.upsert({
    where: { id: 'usr_admin_seed_0001' },
    update: {},
    create: {
      id: 'usr_admin_seed_0001',
      email: 'admin@local',
      passwordHash: '!UNSET-SET-IN-TDA-002',
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  });
  console.log('  ✓ ADMIN user usr_admin_seed_0001');

  await prisma.consentDocument.upsert({
    where: { id: 'cdoc_seed_0001' },
    update: {},
    create: {
      id: 'cdoc_seed_0001',
      version: '2026-06-27.0-placeholder',
      kind: 'risk-disclosure',
      body: 'PLACEHOLDER - replaced in TDA-009',
      contentHash: 'sha256:placeholder',
    },
  });
  console.log('  ✓ Consent document cdoc_seed_0001');

  console.log('Seeding instruments...');

  for (const instrument of SEED_INSTRUMENTS) {
    await prisma.instrument.upsert({
      where: {
        symbol_exchange_token: {
          symbol: instrument.symbol,
          exchange: instrument.exchange,
          token: instrument.token,
        },
      },
      update: {
        name: instrument.name,
        segment: instrument.segment,
        lotSize: instrument.lotSize,
        tickSize: instrument.tickSize,
        isActive: true,
      },
      create: {
        ...instrument,
        isActive: true,
      },
    });
    console.log(`  ✓ ${instrument.symbol} (${instrument.token})`);
  }

  console.log(`\nSeeded ${SEED_INSTRUMENTS.length} instruments.`);
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
