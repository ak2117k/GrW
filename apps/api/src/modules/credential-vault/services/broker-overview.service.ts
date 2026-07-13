import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  CREDENTIAL_DECRYPTOR,
  CredentialDecryptor,
} from '../execution/credential-decryptor';
import { PerUserBrokerSessionFactory } from '../../auto-execution/services/per-user-broker-session.factory';
import { AngelOneAuthService } from '../../market-data/services/angel-one-auth.service';

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
 * Performs exactly ONE ephemeral broker login (not three) to respect Angel One
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
    // The persistent market-data feed session. When the caller IS the feed
    // account, reads reuse this session instead of a fresh login (see getOverview).
    private readonly authService: AngelOneAuthService,
  ) {}

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

    // If the caller IS the market-data feed account, read through the feed's
    // ALREADY-authenticated session instead of a fresh ephemeral login. A second
    // login on the same Angel One client code invalidates the feed's live
    // WebSocket session (Angel One allows ~one session per account), which would
    // stall live prices/charts for the whole app. Same account, one session.
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isFeedAccount: true },
    });
    if (user?.isFeedAccount && this.authService.isAuthenticated()) {
      try {
        const api = this.authService.getSmartApi();
        return sanitizeOverview({
          funds: (await api.getRMS())?.data ?? null,
          profile: (await api.getProfile())?.data ?? null,
          positions: (await api.getPosition())?.data ?? null,
          holdings: (await api.getAllHolding())?.data ?? null,
        });
      } catch (err) {
        this.logger.warn(
          `Feed-session overview read failed; falling back to ephemeral login: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    const raw = await this.decryptor.withDecryptedCredentials(
      userId,
      { reason: 'REVALIDATE' },
      (creds) =>
        this.brokerFactory.withSession(creds, async (session) => ({
          funds: await session.getFunds(),
          profile: await session.getProfile(),
          positions: await session.getPositions(),
          holdings: await session.getHoldings(),
        })),
    );

    return sanitizeOverview(raw);
  }

  /**
   * Fetch + sanitize the caller's day trade book (executed trades) from Angel
   * One's `getTradeBook`. Uses the SAME feed-session-reuse-or-ephemeral dual path
   * as {@link getOverview}: if the caller IS the market-data feed account and its
   * session is live, read through it (a second login on the same client code
   * would invalidate the feed's WebSocket session); otherwise fall back to one
   * disposable ephemeral login. Returns a sanitized, secret-free list. Throws
   * NotFoundException (→ 404) when the user has no stored Angel One credentials.
   */
  async getTrades(userId: string): Promise<BrokerTradeDto[]> {
    const row = await this.prisma.brokerCredential.findUnique({ where: { userId } });
    if (!row) {
      throw new NotFoundException('No Angel One account connected');
    }

    // Same account, one session: reuse the live feed session when the caller IS
    // the feed account, so we never trigger a second login that would stall the
    // shared market-data WebSocket (see getOverview for the full rationale).
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isFeedAccount: true },
    });
    if (user?.isFeedAccount && this.authService.isAuthenticated()) {
      try {
        const api = this.authService.getSmartApi();
        return sanitizeTrades((await api.getTradeBook())?.data ?? null);
      } catch (err) {
        this.logger.warn(
          `Feed-session trade-book read failed; falling back to ephemeral login: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    const raw = await this.decryptor.withDecryptedCredentials(
      userId,
      { reason: 'REVALIDATE' },
      (creds) =>
        this.brokerFactory.withSession(creds, (session) => session.getTradeBook()),
    );

    return sanitizeTrades(raw);
  }
}
