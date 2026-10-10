/**
 * Pure assembly of the overnight packet's evidence blocks.
 *
 * The adapter (`adapters/overnight-evidence.adapter.ts`) does the I/O against
 * the existing news, options-chain and market-data services and hands back RAW
 * readings; everything that turns a reading into a claim the judge will read —
 * a build-up quadrant, a staleness flag, a decay figure, "there is no pre-open
 * price yet" — happens here, where it can be tested without a container.
 *
 * Same discipline as the live packet (`context-packet.service.ts`): every block
 * is present WITH provenance or absent WITH a reason. Never a silent zero — an
 * unavailable PCR reported as 0 reads as "extremely bearish", an unavailable OI
 * change as "nobody is adding".
 *
 * Imports only pure modules — see the note at the top of `overnight-calendar.ts`.
 */
import type { Prisma } from '@prisma/client';
import { GreeksCalculatorService } from '../../options-chain/services/greeks-calculator.service';
import { absent, present, type Block } from '../services/context-packet.service';
import type { Segment, Side } from '../charges';

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// ─── Option symbol ───────────────────────────────────────────────────────────

export interface ParsedOption {
  underlying: string;
  strike: number;
  optionType: 'CE' | 'PE';
}

/**
 * Strike and type off a broker option tradingsymbol — `NIFTY13OCT2625000CE`,
 * `CRUDEOIL16OCT265600CE`. The date is DDMMMYY; whatever digits follow it up to
 * CE/PE are the strike. Null for anything else: a future, cash, or a spelling
 * this does not recognise — a wrong strike would pick the wrong chain row.
 */
export function parseOptionSymbol(symbol: string): ParsedOption | null {
  const m = /^([A-Z&-]+?)(\d{2}[A-Z]{3}\d{2})(\d+(?:\.\d+)?)(CE|PE)$/.exec(
    String(symbol ?? '').trim().toUpperCase(),
  );
  if (!m) return null;
  const strike = Number(m[3]);
  if (!Number.isFinite(strike) || strike <= 0) return null;
  return { underlying: m[1], strike, optionType: m[4] as 'CE' | 'PE' };
}

// ─── Build-up ────────────────────────────────────────────────────────────────

export type BuildUp = 'LONG_BUILD_UP' | 'SHORT_BUILD_UP' | 'SHORT_COVERING' | 'LONG_UNWINDING';

/**
 * The four OI quadrants, from the sign of the price change against the sign of
 * the OI change:
 *
 *              OI up              OI down
 *   price up   LONG_BUILD_UP      SHORT_COVERING
 *   price dn   SHORT_BUILD_UP     LONG_UNWINDING
 *
 * Null when either side is flat or not a finite reading — a quadrant read off a
 * zero is a guess presented as a classification.
 */
export function classifyBuildUp(
  priceChange: number | null | undefined,
  oiChange: number | null | undefined,
): BuildUp | null {
  if (!Number.isFinite(priceChange as number) || !Number.isFinite(oiChange as number)) return null;
  const p = priceChange as number;
  const o = oiChange as number;
  if (p === 0 || o === 0) return null;
  if (p > 0) return o > 0 ? 'LONG_BUILD_UP' : 'SHORT_COVERING';
  return o > 0 ? 'SHORT_BUILD_UP' : 'LONG_UNWINDING';
}

// ─── Overnight decay ─────────────────────────────────────────────────────────

export type OvernightDecay = {
  thetaPerUnitPerDay: number;
  nightDays: number;
  perUnitOvernight: number;
  /** Signed rupee effect on THIS position: negative hurts it, positive helps it. */
  rupeesForPosition: number;
  method: string;
};

export interface DecayInput {
  segment: Segment;
  side: Side;
  qty: number;
  /** The contract's own last price — the premium. */
  premium: number;
  spot: number | null;
  strike: number | null;
  optionType: 'CE' | 'PE' | null;
  /** 'YYYY-MM-DD'. */
  expiry: string | null;
  now: Date;
  nextOpen: Date | null;
  /** Theta per unit per calendar day off the options chain, when there is one. */
  chainTheta: number | null;
}

const greeks = new GreeksCalculatorService();
const RISK_FREE = 0.065;

/**
 * One night's time decay for an option position, in rupees.
 *
 * `nightDays` is the calendar time from `now` to the next session open — 17.5
 * hours on a weekday night, ~2.7 days over a weekend, more across a holiday.
 * Theta here is per CALENDAR day (`GreeksCalculatorService` divides by 365), so
 * it scales directly.
 *
 * Theta source, in order: the options chain's own greeks for this strike; else
 * a Black–Scholes ESTIMATE from `GreeksCalculatorService`, with the implied vol
 * backed out of the last premium — labelled as an estimate in `method`, because
 * it is one. Absent when neither can be had.
 */
export function overnightDecayBlock(input: DecayInput): Block<OvernightDecay> {
  if (input.segment === 'FUT') {
    return absent('this is a future — futures carry no option time decay (theta); not applicable');
  }
  if (input.segment !== 'OPT') return absent('not an option — no time decay to estimate');
  if (!input.nextOpen) return absent('the next session open could not be resolved, so the night’s length is unknown');

  const nightDays = Math.max(0, (input.nextOpen.getTime() - input.now.getTime()) / DAY_MS);

  let theta: number | null = null;
  let method = '';
  if (Number.isFinite(input.chainTheta as number) && input.chainTheta !== 0) {
    theta = input.chainTheta as number;
    method = 'options-chain greeks for this strike (Black–Scholes theta per calendar day)';
  } else {
    const estimate = estimateTheta(input);
    if (estimate !== null) {
      theta = estimate;
      method =
        'ESTIMATE — Black–Scholes theta from greeks-calculator.service, implied vol backed out of ' +
        'the last premium, r = 6.5%; the options chain had no theta for this strike';
    }
  }
  if (theta === null) {
    return absent(
      'no theta: the options chain had none for this strike and a Black–Scholes estimate needs the ' +
        'underlying spot, strike, premium and expiry, which were not all available',
    );
  }

  // A long option cannot lose more than it is worth overnight.
  const perUnitOvernight = Math.max(theta * nightDays, -Math.abs(input.premium));
  const sign = input.side === 'LONG' ? 1 : -1;
  return present(
    {
      thetaPerUnitPerDay: round2(theta),
      nightDays: round4(nightDays),
      perUnitOvernight: round2(perUnitOvernight),
      rupeesForPosition: round2(perUnitOvernight * Math.abs(input.qty) * sign),
      method,
    },
    method.startsWith('ESTIMATE') ? 'greeks-calculator.service (estimate)' : 'options-chain.service greeks',
    input.now.toISOString(),
  );
}

function estimateTheta(input: DecayInput): number | null {
  const { spot, strike, optionType, premium, expiry } = input;
  if (!Number.isFinite(spot as number) || (spot as number) <= 0) return null;
  if (!Number.isFinite(strike as number) || (strike as number) <= 0) return null;
  if (!optionType || !Number.isFinite(premium) || premium <= 0 || !expiry) return null;
  // Expiry at the 15:30 IST close of the expiry date — the NSE convention; for MCX
  // it is an approximation and the estimate is labelled as one.
  const expiryAt = Date.parse(`${expiry}T15:30:00+05:30`);
  if (!Number.isFinite(expiryAt)) return null;
  const years = (expiryAt - input.now.getTime()) / (365.25 * DAY_MS);
  if (years <= 0) return null;
  const iv = greeks.calculateIV(premium, spot as number, strike as number, years, RISK_FREE, optionType);
  if (!Number.isFinite(iv) || iv <= 0) return null;
  const g = greeks.calculateGreeks(spot as number, strike as number, years, RISK_FREE, iv, optionType);
  return Number.isFinite(g.theta) && g.theta !== 0 ? g.theta : null;
}

// ─── Pre-open price ──────────────────────────────────────────────────────────

/** Minutes since IST midnight at which a venue first prints a price for the day. */
function firstPrintMin(exchange: string): { min: number; what: string } {
  return String(exchange ?? '').toUpperCase() === 'MCX'
    ? { min: 9 * 60, what: 'MCX opens at 09:00 IST and has no pre-open session' }
    : { min: 9 * 60, what: 'the NSE/BSE pre-open order collection runs 09:00–09:08 IST' };
}

/**
 * The pre-open / indicative price, if one genuinely exists for today.
 *
 * A candidate price is used ONLY when it was printed today at or after the
 * venue's first print of the day. At 08:50 nothing qualifies — NSE's pre-open
 * runs 09:00–09:08 and MCX opens at 09:00 — and the block says so, plainly,
 * rather than relabelling yesterday's close as an opening indication.
 */
export function preOpenPriceBlock(
  exchange: string,
  now: Date,
  candidate: { price: number; at: string | null } | null,
): Block<number> {
  const first = firstPrintMin(exchange);
  const todayMidnight = Date.parse(`${new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10)}T00:00:00.000Z`) - IST_OFFSET_MS;
  const firstPrintAt = todayMidnight + first.min * 60_000;
  const previous =
    'position.ltp is the PREVIOUS session’s last price — do not read it as today’s opening level.';

  if (now.getTime() < firstPrintAt) {
    return absent(
      `no pre-open or indicative price exists yet: ${first.what}, and this review runs before that. ${previous}`,
    );
  }
  const at = candidate?.at ? Date.parse(candidate.at) : Number.NaN;
  if (!candidate || !Number.isFinite(candidate.price) || !Number.isFinite(at) || at < firstPrintAt || at > now.getTime()) {
    return absent(
      `no price has been printed today since ${first.what.includes('MCX') ? 'the 09:00 open' : 'the 09:00 pre-open began'}; ` +
        `the only price on record predates it. ${previous}`,
    );
  }
  return present(candidate.price, `${exchange.toUpperCase()} pre-open/indicative print (today)`, candidate.at as string);
}

// ─── News since the close ────────────────────────────────────────────────────

export type NewsScope = 'symbol' | 'sector' | 'index' | 'macro';

export interface NewsItemIn {
  title: string;
  source: string;
  publishedAt: string;
  sentiment: string | null;
  url: string | null;
  scope: NewsScope;
}

export interface NewsEvidence {
  items: NewsItemIn[];
  /** When the news store last took in an article (its newest `fetchedAt`), or null. */
  lastFetchAt: string | null;
}

/** Headlines are evidence, not a feed: past this the prompt is reading noise. */
export const NEWS_SINCE_CLOSE_CAP = 12;

function newsKey(item: NewsItemIn): string {
  const title = item.title.trim().toLowerCase().replace(/\s+/g, ' ');
  return title || (item.url ?? '');
}

/**
 * Headlines since the last close for the symbol, its sector, its index and the
 * market at large — deduped (first scope wins, in the order the adapter asked),
 * newest first, capped.
 *
 * STALENESS IS PART OF THE ANSWER. The aggregator fetches on a schedule; if it
 * has not taken anything in since the close, an empty list means "we did not
 * look", not "nothing happened", and the block must say which.
 */
export function newsSinceCloseBlock(
  evidence: NewsEvidence,
  since: Date,
  now: Date,
  cap: number = NEWS_SINCE_CLOSE_CAP,
): Block<Prisma.InputJsonValue> {
  const lastFetch = evidence.lastFetchAt ? Date.parse(evidence.lastFetchAt) : Number.NaN;
  const stale = !Number.isFinite(lastFetch) || lastFetch < since.getTime();

  const seen = new Set<string>();
  const kept: NewsItemIn[] = [];
  for (const item of evidence.items) {
    const t = Date.parse(item.publishedAt);
    if (!Number.isFinite(t) || t < since.getTime() || t > now.getTime() + 60_000) continue;
    const key = newsKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push(item);
  }
  kept.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));

  if (kept.length === 0 && stale) {
    return absent(
      `the news store has not been refreshed since the last close (${since.toISOString()}; last fetch ` +
        `${evidence.lastFetchAt ?? 'never'}), so the absence of headlines is NOT evidence that nothing ` +
        'was published — it is a failure to look',
    );
  }

  const items = kept.slice(0, cap).map((i) => ({
    headline: i.title,
    title: i.title,
    source: i.source,
    publishedAt: i.publishedAt,
    sentiment: i.sentiment,
    scope: i.scope,
  }));
  return present(
    {
      since: since.toISOString(),
      items,
      shown: items.length,
      totalSinceClose: kept.length,
      stale,
      lastFetchAt: evidence.lastFetchAt,
      ...(stale
        ? {
            staleness:
              'STALE: the news store has not taken in any article since the last close; there may be ' +
              'news it has not fetched yet',
          }
        : {}),
    },
    `news-aggregator.service (stored articles published since the last close; symbol, sector, index, macro; newest first, max ${cap})`,
    evidence.lastFetchAt ?? now.toISOString(),
  );
}

// ─── OI analysis ─────────────────────────────────────────────────────────────

export type RawOiAnalysis =
  | { available: false; reason: string }
  | {
      available: true;
      source: string;
      at: string;
      expiry: string;
      spot: number | null;
      pcr: number | null;
      maxPain: number | null;
      callWall: number | null;
      putWall: number | null;
      totalCeOi: number | null;
      totalPeOi: number | null;
      /** Sum of the chain's own per-strike day OI change, when the source supplies it. */
      totalOiChange: number | null;
      underlyingPriceChange: { value: number; source: string } | null;
      prevSession: {
        at: string;
        pcr: number | null;
        totalCeOi: number | null;
        totalPeOi: number | null;
        spot: number | null;
      } | null;
      contract: {
        strike: number;
        optionType: 'CE' | 'PE';
        ltp: number | null;
        oi: number | null;
        oiChange: number | null;
        prev: { ltp: number | null; oi: number | null } | null;
      } | null;
    };

const finite = (n: number | null | undefined): n is number => Number.isFinite(n as number);
const positive = (n: number | null | undefined): n is number => finite(n) && n > 0;

/**
 * End-of-day OI read for the position: PCR, walls and max pain near spot, the
 * build-up on the contract and on the underlying, and the change against the
 * previous session's stored chain. Every sub-reading is its own block, so one
 * missing piece is a stated absence and not a hole in the rest.
 */
export function oiAnalysisBlock(raw: RawOiAnalysis): Block<Prisma.InputJsonValue> {
  if (!raw.available) return absent(raw.reason);
  const { source, at } = raw;

  const pcr = positive(raw.pcr)
    ? present(raw.pcr, `${source} getPCR (put OI / call OI, expiry ${raw.expiry})`, at)
    : absent('PCR unavailable — the chain carried no open interest to compute it from');
  const maxPain = positive(raw.maxPain)
    ? present(raw.maxPain, `${source} getMaxPain (expiry ${raw.expiry})`, at)
    : absent('max pain unavailable — the chain carried no open interest to compute it from');
  const walls =
    positive(raw.callWall) || positive(raw.putWall)
      ? present(
          { callWall: positive(raw.callWall) ? raw.callWall : null, putWall: positive(raw.putWall) ? raw.putWall : null },
          `${source} getOISummary (highest-OI call and put strikes)`,
          at,
        )
      : absent('OI walls unavailable — no strike carried open interest');

  const totalNow = finite(raw.totalCeOi) && finite(raw.totalPeOi) ? raw.totalCeOi + raw.totalPeOi : null;
  const prev = raw.prevSession;
  const totalPrev = prev && finite(prev.totalCeOi) && finite(prev.totalPeOi) ? prev.totalCeOi + prev.totalPeOi : null;

  const vsPreviousSession =
    prev && (positive(prev.pcr) || totalPrev !== null)
      ? present(
          {
            pcrThen: positive(prev.pcr) ? prev.pcr : null,
            pcrChange: positive(prev.pcr) && positive(raw.pcr) ? round2(raw.pcr - prev.pcr) : null,
            totalOiThen: totalPrev,
            totalOiChange: totalPrev !== null && totalNow !== null ? totalNow - totalPrev : null,
            spotThen: positive(prev.spot) ? prev.spot : null,
          },
          'option_chain_snapshots (the last chain stored before today’s session)',
          prev.at,
        )
      : absent('no options-chain snapshot stored from the previous session — the change vs then cannot be computed');

  let contract: Block<Prisma.InputJsonValue>;
  if (!raw.contract) {
    contract = absent('no option leg for this position in the chain (a future, or the strike is not in the chain)');
  } else {
    const c = raw.contract;
    const priceChange = c.prev && positive(c.prev.ltp) && positive(c.ltp) ? round2(c.ltp - c.prev.ltp) : null;
    let oiChange: number | null = null;
    let oiChangeSource = 'unavailable';
    if (finite(c.oiChange) && c.oiChange !== 0) {
      oiChange = c.oiChange;
      oiChangeSource = 'the chain’s own day OI change for this strike';
    } else if (c.prev && finite(c.prev.oi) && finite(c.oi)) {
      oiChange = c.oi - c.prev.oi;
      oiChangeSource = 'OI now minus OI in the previous session’s stored chain';
    }
    const buildUp = classifyBuildUp(priceChange, oiChange);
    contract =
      priceChange === null && oiChange === null
        ? absent('the contract’s price and OI change vs the previous session are both unavailable')
        : present(
            {
              strike: c.strike,
              optionType: c.optionType,
              oi: finite(c.oi) ? c.oi : null,
              oiChange,
              oiChangeSource,
              priceChange,
              priceChangeSource:
                priceChange === null ? 'unavailable — no previous-session price for this strike' : 'premium now minus premium in the previous session’s stored chain',
              buildUp,
              buildUpNote: buildUp === null ? 'not classifiable — price or OI change is flat or unavailable' : 'from price change vs OI change on this contract',
            },
            `${source} (this strike)`,
            at,
          );
  }

  const underlyingOiChange =
    finite(raw.totalOiChange) && raw.totalOiChange !== 0
      ? { value: raw.totalOiChange, how: 'sum of the chain’s per-strike day OI change' }
      : totalPrev !== null && totalNow !== null
        ? { value: totalNow - totalPrev, how: 'total chain OI now minus the previous session’s stored chain' }
        : null;
  const underlyingBuildUp = classifyBuildUp(raw.underlyingPriceChange?.value, underlyingOiChange?.value);
  const underlying =
    raw.underlyingPriceChange && underlyingOiChange
      ? present(
          {
            priceChange: raw.underlyingPriceChange.value,
            priceChangeSource: raw.underlyingPriceChange.source,
            oiChange: underlyingOiChange.value,
            oiChangeSource: underlyingOiChange.how,
            buildUp: underlyingBuildUp,
          },
          'PROXY: underlying price change vs TOTAL OPTIONS-CHAIN OI change (no futures OI series is wired)',
          at,
        )
      : absent(
          'underlying build-up unavailable — ' +
            (raw.underlyingPriceChange ? 'no OI change for the chain' : 'no previous-close price change for the underlying'),
        );

  return present(
    {
      expiry: raw.expiry,
      spotRef: positive(raw.spot) ? raw.spot : null,
      pcr,
      maxPain,
      walls,
      contract,
      underlying,
      vsPreviousSession,
    },
    source,
    at,
  );
}

// ─── Market cues ─────────────────────────────────────────────────────────────

export type Cue = {
  value: number;
  change: number | null;
  changePercent: number | null;
  direction: 'UP' | 'DOWN' | 'FLAT' | 'UNKNOWN';
  ageMinutes: number | null;
};

/** A move under this (percent) reads as FLAT. */
const FLAT_PCT = 0.1;

/** One market cue — value, direction and freshness — or a stated absence. */
export function cueBlock(
  reading: { value: number; change: number | null; changePercent: number | null; at: string | null } | null,
  source: string,
  now: Date,
  reason = 'no reading available',
): Block<Cue> {
  if (!reading || !finite(reading.value)) return absent(reason);
  const pct = finite(reading.changePercent) ? reading.changePercent : null;
  const direction = pct === null ? 'UNKNOWN' : Math.abs(pct) < FLAT_PCT ? 'FLAT' : pct > 0 ? 'UP' : 'DOWN';
  const at = reading.at ?? now.toISOString();
  const age = Date.parse(at);
  return present(
    {
      value: reading.value,
      change: finite(reading.change) ? reading.change : null,
      changePercent: pct,
      direction,
      ageMinutes: Number.isFinite(age) ? Math.max(0, Math.round((now.getTime() - age) / 60_000)) : null,
    },
    source,
    at,
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
