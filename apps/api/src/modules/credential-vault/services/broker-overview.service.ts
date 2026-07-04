import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  CREDENTIAL_DECRYPTOR,
  CredentialDecryptor,
} from '../execution/credential-decryptor';
import { PerUserBrokerSessionFactory } from '../../auto-execution/services/per-user-broker-session.factory';

/**
 * Sanitized, secret-free account overview returned by GET /api/broker/overview.
 * Contains ONLY the safe fields below — never a token, credential, or the raw
 * Angel One envelope (TDA-017 security seam).
 */
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

/** Raw broker sections gathered inside the single ephemeral session. */
interface RawOverview {
  funds: any;
  profile: any;
  positions: any;
}

/** Map the raw broker sections into the sanitized, secret-free DTO. */
export function sanitizeOverview(raw: RawOverview): BrokerOverview {
  return {
    funds: mapFunds(raw.funds),
    profile: mapProfile(raw.profile),
    positions: mapPositions(raw.positions),
  };
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
  constructor(
    @Inject(CREDENTIAL_DECRYPTOR) private readonly decryptor: CredentialDecryptor,
    private readonly brokerFactory: PerUserBrokerSessionFactory,
    private readonly prisma: PrismaService,
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

    const raw = await this.decryptor.withDecryptedCredentials(
      userId,
      { reason: 'REVALIDATE' },
      (creds) =>
        this.brokerFactory.withSession(creds, async (session) => ({
          funds: await session.getFunds(),
          profile: await session.getProfile(),
          positions: await session.getPositions(),
        })),
    );

    return sanitizeOverview(raw);
  }
}
