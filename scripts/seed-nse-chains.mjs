// NSE option chain bootstrap via Playwright + v3 API.
//
// Flow:
//   1. Launch real Chrome, navigate to /option-chain (warms Akamai session).
//   2. NSE's own JS auto-fires an /api/option-chain-v3 call for NIFTY's
//      nearest expiry — we don't need the response, we just need the session
//      to be primed by the time we start XHR-ing from the page context.
//   3. For each symbol, page.evaluate(fetch) /api/option-chain-contract-info
//      to get the list of expiries.
//   4. For each (symbol, expiry), page.evaluate(fetch) /api/option-chain-v3
//      and persist the result as an OptionChainSnapshot.
//
// Persisted rows are de-duped per (symbol, expiry, day) — running twice in
// the same day replaces the previous snapshot instead of piling up.

import { chromium } from 'playwright';
import { PrismaClient } from '@prisma/client';

const SYMBOLS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'];
const NSE_HOME = 'https://www.nseindia.com';
const MAX_EXPIRIES_PER_SYMBOL = 4; // just the nearest few

const prisma = new PrismaClient();

function nseExpiryToIso(s) {
  const [d, mon, y] = s.split('-');
  const months = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
                   Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  return `${y}-${months[mon]}-${d.padStart(2, '0')}`;
}

function mapLeg(leg) {
  if (!leg) return null;
  return {
    ltp: Number(leg.lastPrice ?? 0),
    oi: Number(leg.openInterest ?? 0),
    oiChange: Number(leg.changeinOpenInterest ?? 0),
    volume: Number(leg.totalTradedVolume ?? 0),
    iv: Number(leg.impliedVolatility ?? 0),
    delta: 0, gamma: 0, theta: 0, vega: 0,
    bidPrice: Number(leg.bidprice ?? 0),
    askPrice: Number(leg.askPrice ?? 0),
  };
}

async function persist(symbol, expiryIso, spotPrice, rows) {
  const chain = rows.map((r) => ({
    strikePrice: r.strikePrice,
    expiryDate: expiryIso,
    ceData: mapLeg(r.CE),
    peData: mapLeg(r.PE),
  }));
  chain.sort((a, b) => a.strikePrice - b.strikePrice);

  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  await prisma.optionChainSnapshot.deleteMany({
    where: {
      underlying: symbol,
      expiryDate: new Date(expiryIso),
      capturedAt: { gte: dayStart },
    },
  });
  await prisma.optionChainSnapshot.create({
    data: {
      underlying: symbol,
      expiryDate: new Date(expiryIso),
      spotPrice,
      source: 'NSE',
      strikeCount: chain.length,
      chainJson: chain,
    },
  });
}

async function main() {
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
  });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'Asia/Kolkata',
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await ctx.newPage();

  console.log('Warming NSE session via /option-chain ...');
  await page.goto(`${NSE_HOME}/option-chain`, { waitUntil: 'domcontentloaded' });
  // Wait long enough for Akamai's bm_* sensor scripts to accumulate data
  // and for NSE's own first v3 call to succeed. Empirically, 7 s is safe.
  await page.waitForTimeout(7000);
  console.log(`Session warm — page title: "${await page.title()}"`);

  let totalRows = 0;
  let totalSnapshots = 0;

  for (const symbol of SYMBOLS) {
    console.log(`\n[${symbol}] fetching contract info...`);
    const info = await page.evaluate(async (s) => {
      try {
        const res = await fetch(
          `/api/option-chain-contract-info?symbol=${s}`,
          { headers: { Accept: 'application/json, text/plain, */*' }, credentials: 'include' },
        );
        return { status: res.status, body: await res.text() };
      } catch (e) {
        return { status: 0, body: String(e) };
      }
    }, symbol);

    if (info.status !== 200 || info.body.length < 50) {
      console.warn(`  contract-info failed: HTTP ${info.status}, ${info.body.length}B`);
      continue;
    }

    let expiries = [];
    try {
      const parsed = JSON.parse(info.body);
      expiries = parsed?.expiryDates ?? parsed?.records?.expiryDates ?? [];
    } catch (e) {
      console.warn(`  contract-info parse error: ${e.message}`);
      continue;
    }

    if (expiries.length === 0) {
      console.warn(`  no expiries found`);
      continue;
    }

    const picked = expiries.slice(0, MAX_EXPIRIES_PER_SYMBOL);
    console.log(`  expiries (${picked.length}/${expiries.length}): ${picked.join(', ')}`);

    for (const nseExpiry of picked) {
      await page.waitForTimeout(600); // gentle pacing
      const chainResp = await page.evaluate(
        async ({ s, e }) => {
          try {
            const res = await fetch(
              `/api/option-chain-v3?type=Indices&symbol=${s}&expiry=${encodeURIComponent(e)}`,
              { headers: { Accept: 'application/json, text/plain, */*' }, credentials: 'include' },
            );
            return { status: res.status, body: await res.text() };
          } catch (err) {
            return { status: 0, body: String(err) };
          }
        },
        { s: symbol, e: nseExpiry },
      );

      if (chainResp.status !== 200 || chainResp.body.length < 500) {
        console.warn(`    ${nseExpiry}: HTTP ${chainResp.status}, ${chainResp.body.length}B`);
        continue;
      }

      let json;
      try {
        json = JSON.parse(chainResp.body);
      } catch {
        console.warn(`    ${nseExpiry}: parse error`);
        continue;
      }

      const records = json?.records ?? json;
      const data = records?.data ?? [];
      const spotPrice = Number(records?.underlyingValue ?? 0);
      if (data.length === 0 || spotPrice === 0) {
        console.warn(`    ${nseExpiry}: empty records (spot=${spotPrice}, rows=${data.length})`);
        continue;
      }

      const expiryIso = nseExpiryToIso(nseExpiry);
      await persist(symbol, expiryIso, spotPrice, data);
      totalRows += data.length;
      totalSnapshots++;
      console.log(`    ${nseExpiry} (${expiryIso}): ${data.length} strikes, spot=${spotPrice} ✓`);
    }
  }

  await browser.close();
  await prisma.$disconnect();
  console.log(`\nDone. ${totalSnapshots} snapshots, ${totalRows} total strikes.`);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
