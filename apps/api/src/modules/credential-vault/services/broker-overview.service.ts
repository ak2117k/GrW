import { Inject, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  CREDENTIAL_DECRYPTOR,
  CredentialDecryptor,
} from '../execution/credential-decryptor';
import { PerUserBrokerSessionFactory } from '../../auto-execution/services/per-user-broker-session.factory';
import { AngelOneAuthService } from '../../market-data/services/angel-one-auth.service';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { UserFeedManager } from '../../market-data/services/user-feed-manager.service';
import {
  OwnSessionUnavailableError,
  withOwnAccountSession,
  type OwnAccountSessionDeps,
} from '../../auto-execution/services/own-account-session';
import type { UserBrokerSession } from '../../auto-execution/services/per-user-broker-session.factory';

/**
 * Sanitized, secret-free account overview returned by GET /api/broker/overview.
 * Contains ONLY the safe fields below — never a token, credential, or the raw
 * Angel One envelope (TDA-017 security seam).
 */
/** A single sanitized equity holding (delivered stock) row. */
export interface Holding {
  symbol: string;
  exchange: string;
  qty: number;
  avgPrice: number;
  ltp: number;
  close: number;
  currentValue: number;
  pnl: number;
  pnlPercent: number;
  dayChangePercent: number;
  /**
   * The instrument's token, for deep-linking to its chart. Empty when the
   * broker omitted it — see the note on a position's `token` for why the UI
   * must then not pretend to have one.
   *
   * No underlying pair here, unlike a position: a holding is cash equity, so
   * the thing held IS the thing charted.
   */
  token: string;
  /** Raw Angel One product code (e.g. DELIVERY / MTF). */
  product: string;
  /** Derived holding classification for the UI badge. */
  holdingType: 'NORMAL' | 'MTF' | 'PLEDGED';
}

/**
 * Classify a raw Angel One holding: pledged (collateralised for margin) →
 * PLEDGED; product flagged MTF (margin-trading facility) → MTF; else NORMAL.
 */
function classifyHolding(h: any): Holding['holdingType'] {
  if (toNum(h?.collateralquantity) > 0) return 'PLEDGED';
  if (String(h?.product ?? '').toUpperCase().includes('MTF')) return 'MTF';
  return 'NORMAL';
}

export interface BrokerOverview {
  funds: { availableCash: number; net: number; utilisedMargin: number };
  profile: { name: string; broker: string; exchanges: string[] };
  positions: Array<{
    symbol: string;
    exchange: string;
    netQty: number;
    ltp: number;
    pnl: number;
    /**
     * The traded instrument's own token — for a derivative, the CONTRACT's, not
     * the underlying's. Empty string when the broker omitted it.
     *
     * Carried so the UI can deep-link to this instrument's chart. A chart link
     * without a token is not a weaker link, it is a BROKEN one: /charts ignores
     * a URL with no token and silently leaves whatever chart was open, so the
     * click looks like it worked and shows the wrong instrument.
     */
    token: string;
    /**
     * The UNDERLYING's base symbol for a derivative (`BDL` for
     * `BDL25AUG261400CE`), taken from Angel's own `symbolname`. Equal to the
     * traded symbol for cash. Null when the broker omitted it.
     *
     * Not parsed out of the tradingsymbol: the broker already knows the answer,
     * and a regex over `<NAME><DDMMMYY><STRIKE><CE|PE>` guesses wrong on names
     * that contain digits.
     */
    underlyingSymbol: string | null;
    /**
     * The underlying's NSE CASH token, resolved from the instrument master.
     * Null when it could not be resolved — see the token note above for why the
     * UI must then render plain text rather than a link.
     */
    underlyingToken: string | null;
  }>;
  holdings: Holding[];
  holdingSummary: {
    investedValue: number;
    currentValue: number;
    totalPnl: number;
    totalPnlPercent: number;
  };
}

/**
 * A single sanitized executed-trade row from the caller's Angel One day trade
 * book (GET /api/broker/trades). Field names/types are a HARD contract — the
 * frontend depends on them. Contains ONLY the safe fields below — never a token,
 * credential, or the raw Angel One envelope (TDA-017 security seam).
 */
export interface BrokerTradeDto {
  symbol: string;
  exchange: string;
  side: 'BUY' | 'SELL' | string;
  qty: number;
  price: number;
  /** Angel One `filltime` string, '' if absent. */
  time: string;
  product: string;
  orderId: string;
}

/** Coerce a broker numeric-string (or number/null/undefined) to a finite number. */
function toNum(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}

/** Angel One RMS `data` → sanitized funds (zeros when the section is empty). */
function mapFunds(rms: any): BrokerOverview['funds'] {
  return {
    availableCash: toNum(rms?.availablecash),
    net: toNum(rms?.net),
    utilisedMargin: toNum(rms?.utiliseddebits),
  };
}

/** Angel One profile `data` → sanitized profile (safe empties when absent). */
function mapProfile(profile: any): BrokerOverview['profile'] {
  const exchanges = Array.isArray(profile?.exchanges)
    ? profile.exchanges.map((e: unknown) => String(e))
    : [];
  return {
    name: profile?.name ? String(profile.name) : '',
    broker: profile?.broker ? String(profile.broker) : 'angel_one',
    exchanges,
  };
}

/** Angel One position `data` (array) → sanitized rows (empty array when absent). */
function mapPositions(positions: any): BrokerOverview['positions'] {
  if (!Array.isArray(positions)) return [];
  return positions.map((p: any) => ({
    symbol: p?.tradingsymbol ? String(p.tradingsymbol) : '',
    exchange: p?.exchange ? String(p.exchange) : '',
    netQty: toNum(p?.netqty),
    ltp: toNum(p?.ltp),
    pnl: toNum(p?.pnl),
    token: p?.symboltoken ? String(p.symboltoken) : '',
    underlyingSymbol: p?.symbolname ? String(p.symbolname).trim().toUpperCase() : null,
    // Left null here ON PURPOSE: resolving it needs the instrument master, and
    // this function is pure so it stays testable without a database. The
    // service fills it in — see `attachUnderlyingTokens`.
    underlyingToken: null as string | null,
  }));
}

/**
 * Angel One `get_all_holding` `data.holdings[]` → sanitized holding rows (empty
 * array when the section is absent/malformed). `data` here is the whole
 * get_all_holding envelope (`{ holdings, totalholding }`).
 */
function mapHoldings(data: any): Holding[] {
  const holdings = data?.holdings;
  if (!Array.isArray(holdings)) return [];
  return holdings.map((h: any) => {
    const qty = toNum(h?.quantity);
    const ltp = toNum(h?.ltp);
    const close = toNum(h?.close);
    return {
      symbol: h?.tradingsymbol ? String(h.tradingsymbol) : '',
      exchange: h?.exchange ? String(h.exchange) : '',
      qty,
      avgPrice: toNum(h?.averageprice),
      ltp,
      close,
      currentValue: ltp * qty,
      pnl: toNum(h?.profitandloss),
      pnlPercent: toNum(h?.pnlpercentage),
      dayChangePercent: close > 0 ? ((ltp - close) / close) * 100 : 0,
      token: h?.symboltoken ? String(h.symboltoken) : '',
      product: h?.product ? String(h.product) : '',
      holdingType: classifyHolding(h),
    };
  });
}

/** Angel One `get_all_holding` `data.totalholding` → portfolio summary (zeros when absent). */
function mapHoldingSummary(data: any): BrokerOverview['holdingSummary'] {
  const t = data?.totalholding;
  return {
    investedValue: toNum(t?.totalinvvalue),
    currentValue: toNum(t?.totalholdingvalue),
    totalPnl: toNum(t?.totalprofitandloss),
    totalPnlPercent: toNum(t?.totalpnlpercentage),
  };
}

/** Raw broker sections gathered inside the single ephemeral session. */
interface RawOverview {
  funds: any;
  profile: any;
  positions: any;
  holdings: any;
}

/** Map the raw broker sections into the sanitized, secret-free DTO. */
export function sanitizeOverview(raw: RawOverview): BrokerOverview {
  return {
    funds: mapFunds(raw.funds),
    profile: mapProfile(raw.profile),
    positions: mapPositions(raw.positions),
    holdings: mapHoldings(raw.holdings),
    holdingSummary: mapHoldingSummary(raw.holdings),
  };
}

/**
 * Angel One `getTradeBook` `data` (array of executed-trade rows) → sanitized,
 * secret-free trade DTOs (empty array when the section is null/[]/malformed).
 * Sorted newest-first when EVERY row carries a sortable `filltime`; otherwise the
 * broker's own order is preserved.
 */
export function sanitizeTrades(data: any): BrokerTradeDto[] {
  if (!Array.isArray(data)) return [];
  const trades = data.map((t: any) => ({
    symbol: t?.tradingsymbol ? String(t.tradingsymbol) : '',
    exchange: t?.exchange ? String(t.exchange) : '',
    side: t?.transactiontype ? String(t.transactiontype) : '',
    qty: toNum(t?.fillsize ?? t?.quantity),
    price: toNum(t?.fillprice),
    time: String(t?.filltime ?? ''),
    product: String(t?.producttype ?? ''),
    orderId: String(t?.orderid ?? ''),
  }));
  // Newest-first only when every row has a non-empty time to sort by; a same-day
  // Angel One `filltime` (HH:MM:SS) sorts correctly as a string. Otherwise keep
  // the broker's order rather than shuffle rows on partial/absent times.
  if (trades.length > 1 && trades.every((t) => t.time !== '')) {
    trades.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  }
  return trades;
}

/**
 * Live, read-only Angel One account overview for the calling user (TDA-017).
 *
 * Performs at most ONE broker login (not three; none when a session on the
 * caller's own account is already warm) to respect Angel One
 * rate limits, fetching funds + profile + positions inside a single disposable
 * per-user session, then returns a SANITIZED payload — no tokens, no creds, no
 * raw broker envelope.
 *
 * Plaintext creds are obtained ONLY through the isolated {@link CredentialDecryptor}
 * lease, which unwraps → decrypts → runs the callback → zeroizes in a `finally`.
 * This service never sees the encrypted row's key material and never logs creds;
 * login-failure handling (generic error, masked client id, no `error.message`)
 * stays entirely inside {@link PerUserBrokerSessionFactory.withSession}.
 */
@Injectable()
export class BrokerOverviewService {
  private readonly logger = new Logger(BrokerOverviewService.name);

  constructor(
    @Inject(CREDENTIAL_DECRYPTOR) private readonly decryptor: CredentialDecryptor,
    private readonly brokerFactory: PerUserBrokerSessionFactory,
    private readonly prisma: PrismaService,
    // The shared market-data feed session. Borrowed ONLY when it is logged in
    // with the caller's own client code (see readOwnAccount).
    private readonly authService: AngelOneAuthService,
    // The instrument master, for resolving a derivative's underlying to its NSE
    // cash token. Read-only and never on the credential path.
    private readonly instruments: MarketDataRepository,
    // The caller's own warm per-user feed session, preferred (no login).
    @Optional() private readonly userFeeds?: UserFeedManager,
  ) {}

  /**
   * Run `fn` on a session authenticated with the CALLER's own Angel account
   * (warm per-user feed → the shared feed only when its client code equals the
   * caller's vault client code → one ephemeral login). The shared session's
   * credentials resolve env-first, so `isFeedAccount` alone never made it the
   * caller's account. When the only way in would be a second login over a feed
   * session of the same account that is between logins, answer 503 rather than
   * kill that feed.
   */
  private async readOwnAccount<T>(userId: string, fn: (session: UserBrokerSession) => Promise<T>): Promise<T> {
    const deps: OwnAccountSessionDeps = {
      userFeeds: this.userFeeds,
      factory: this.brokerFactory,
      decryptor: this.decryptor,
      authService: this.authService,
    };
    try {
      return await withOwnAccountSession(deps, userId, { reason: 'REVALIDATE' }, (s) => fn(s));
    } catch (err) {
      if (err instanceof OwnSessionUnavailableError) {
        this.logger.warn(`Broker read for ${userId} refused: ${err.message}`);
        throw new ServiceUnavailableException('Your broker session is reconnecting; try again in a few seconds');
      }
      throw err;
    }
  }

  /**
   * Fetch + sanitize the caller's account overview. Throws NotFoundException
   * (→ 404) when the user has no stored Angel One credentials, so the caller
   * never sees a 500 for the expected "not connected yet" case.
   */
  async getOverview(userId: string): Promise<BrokerOverview> {
    // Fail fast + cleanly if there's nothing to decrypt (the decryptor itself
    // would otherwise throw a Prisma "not found" that surfaces as a 500).
    const row = await this.prisma.brokerCredential.findUnique({ where: { userId } });
    if (!row) {
      throw new NotFoundException('No Angel One account connected');
    }

    // One session on the caller's OWN account (a second login on a client code
    // whose feed is live would stall that feed — see readOwnAccount).
    const raw = await this.readOwnAccount(userId, async (session) => ({
      funds: await session.getFunds(),
      profile: await session.getProfile(),
      positions: await session.getPositions(),
      holdings: await session.getHoldings(),
    }));

    return this.attachUnderlyingTokens(sanitizeOverview(raw));
  }

  /**
   * Fills in each position's `underlyingToken` from the instrument master.
   *
   * WHY THE UI NEEDS IT: the dashboard links a position's symbol to the
   * UNDERLYING's chart, because that is where the S/R levels, zones and trend
   * live — all of them are computed for cash equities. The contract's own
   * premium chart hangs off the row's other end and needs only `token`, which
   * the broker already gave us.
   *
   * NEVER THROWS, and a failure leaves `underlyingToken` null rather than
   * guessing. The UI renders an unresolved underlying as plain text: a chart
   * link with no token navigates and silently shows whatever was open before,
   * so a wrong token — or a link that pretends to have one — is materially
   * worse than no link.
   *
   * One lookup per DISTINCT underlying, not per position: five NIFTY contracts
   * are one query, and the whole overview is one broker refresh.
   */
  private async attachUnderlyingTokens(overview: BrokerOverview): Promise<BrokerOverview> {
    const names = [
      ...new Set(overview.positions.map((p) => p.underlyingSymbol).filter((n): n is string => !!n)),
    ];
    if (names.length === 0) return overview;

    const tokens = new Map<string, string>();
    await Promise.all(
      names.map(async (name) => {
        try {
          // `-EQ` FIRST: the NSE master stores cash equities with their series
          // suffix (`BDL-EQ`), while indices (`NIFTY`) carry none. Trying the
          // bare name first would match an unrelated derivative row on a
          // deployment whose master holds more than cash.
          const row =
            (await this.instruments.getInstrumentBySymbol(`${name}-EQ`, 'NSE')) ??
            (await this.instruments.getInstrumentBySymbol(name, 'NSE'));
          if (row?.token) tokens.set(name, String(row.token));
        } catch (err) {
          // Debug, not warn: an unresolvable underlying costs one link on one
          // row, degrades to plain text, and says nothing about the position's
          // own data. Warning per refresh would drown the log.
          this.logger.debug(
            `could not resolve underlying ${name} to an NSE token: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }),
    );

    return {
      ...overview,
      positions: overview.positions.map((p) => ({
        ...p,
        underlyingToken: p.underlyingSymbol ? (tokens.get(p.underlyingSymbol) ?? null) : null,
      })),
    };
  }

  /**
   * Fetch + sanitize the caller's day trade book (executed trades) from Angel
   * One's `getTradeBook`, through the same own-account session as
   * {@link getOverview} (see {@link readOwnAccount}). Returns a sanitized,
   * secret-free list. Throws
   * NotFoundException (→ 404) when the user has no stored Angel One credentials.
   */
  async getTrades(userId: string): Promise<BrokerTradeDto[]> {
    const row = await this.prisma.brokerCredential.findUnique({ where: { userId } });
    if (!row) {
      throw new NotFoundException('No Angel One account connected');
    }

    // Same rule as getOverview: one session on the caller's OWN account.
    const raw = await this.readOwnAccount(userId, (session) => session.getTradeBook());

    return sanitizeTrades(raw);
  }
}
