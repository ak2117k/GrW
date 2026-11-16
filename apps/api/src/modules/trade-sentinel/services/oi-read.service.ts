import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { isStaleChain, oiRead, type ChainSnap, type ChainStrike, type OiRead } from './oi-read';

const CACHE_MS = 60_000;
const IST_MS = 5.5 * 60 * 60 * 1000;
/** Candidate rows scanned (metadata only) to skip stale pre-open snapshots. */
const SCAN_ROWS = 30;
/** How far back a "latest" snapshot may be (covers a long weekend). */
const LATEST_LOOKBACK_MS = 5 * 24 * 60 * 60 * 1000;
/** How far before the latest's session the previous-session baseline may be. */
const BASELINE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

interface Loaded {
  latest: ChainSnap | null;
  baseline: ChainSnap | null;
}

type RowMeta = { id: string; capturedAt: Date; source: string; expiryDate: Date; spotPrice: unknown };

/** IST calendar date of `d` as YYYY-MM-DD. */
export function istDate(d: Date): string {
  return new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);
}

/** UTC instant of IST midnight on the IST calendar day containing `d`. */
export function istDayStart(d: Date): Date {
  return new Date(Date.parse(`${istDate(d)}T00:00:00.000Z`) - IST_MS);
}

/**
 * Loads the OI read for an underlying from `option_chain_snapshots`:
 *   - latest = newest NON-STALE snapshot of the nearest unexpired expiry,
 *   - baseline = newest non-stale snapshot of the same underlying + expiry +
 *     SOURCE captured before the latest's IST session began (previous session).
 * Snapshots are cached 60 s per underlying (the read itself is recomputed per
 * call because spot changes). Never throws: failure → null, logged once per cause.
 */
@Injectable()
export class OiReadService {
  private readonly logger = new Logger(OiReadService.name);
  private readonly cache = new Map<string, { at: number; value: Loaded }>();
  private readonly warned = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  async read(underlying: string, spot: number): Promise<OiRead | null> {
    try {
      const u = (underlying ?? '').trim().toUpperCase();
      if (!u) return null;
      const loaded = await this.load(u);
      if (!loaded.latest) return null;
      return oiRead(loaded.latest, loaded.baseline, spot);
    } catch (err) {
      this.warnOnce(underlying, 'read failed', err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  private async load(u: string): Promise<Loaded> {
    const t = Date.now();
    const hit = this.cache.get(u);
    if (hit && t - hit.at < CACHE_MS) return hit.value;
    const value = await this.fetch(u, t);
    this.cache.set(u, { at: t, value });
    return value;
  }

  private async fetch(u: string, t: number): Promise<Loaded> {
    const nowDate = new Date(t);
    const today = new Date(`${istDate(nowDate)}T00:00:00.000Z`); // @db.Date encoding
    const metas = (await this.prisma.optionChainSnapshot.findMany({
      where: { underlying: u, expiryDate: { gte: today }, capturedAt: { gte: new Date(t - LATEST_LOOKBACK_MS) } },
      orderBy: [{ expiryDate: 'asc' }, { capturedAt: 'desc' }],
      select: { id: true, capturedAt: true, source: true, expiryDate: true, spotPrice: true },
      take: SCAN_ROWS,
    })) as RowMeta[];
    if (metas.length === 0) return { latest: null, baseline: null };
    const nearest = metas[0].expiryDate.getTime();
    const latest = await this.firstLive(metas.filter((m) => m.expiryDate.getTime() === nearest));
    if (!latest) {
      this.warnOnce(u, 'all recent snapshots stale', `every LTP 0 in the last ${SCAN_ROWS} rows of the nearest expiry`);
      return { latest: null, baseline: null };
    }

    const sessionStart = istDayStart(latest.capturedAt);
    const baseMetas = (await this.prisma.optionChainSnapshot.findMany({
      where: {
        underlying: u,
        expiryDate: metas[0].expiryDate,
        source: latest.source,
        capturedAt: { lt: sessionStart, gte: new Date(sessionStart.getTime() - BASELINE_LOOKBACK_MS) },
      },
      orderBy: { capturedAt: 'desc' },
      select: { id: true, capturedAt: true, source: true, expiryDate: true, spotPrice: true },
      take: SCAN_ROWS,
    })) as RowMeta[];
    // Newest live row before the latest's session began = the previous session's last reading.
    const baseline = await this.firstLive(baseMetas);
    return { latest, baseline };
  }

  /** First row (in the given order) whose chain is not stale, with its chainJson loaded. */
  private async firstLive(metas: RowMeta[]): Promise<ChainSnap | null> {
    for (const m of metas) {
      const row = await this.prisma.optionChainSnapshot.findUnique({
        where: { id: m.id },
        select: { chainJson: true },
      });
      const strikes = (Array.isArray(row?.chainJson) ? row!.chainJson : []) as unknown as ChainStrike[];
      if (isStaleChain(strikes)) continue;
      const spot = Number(m.spotPrice);
      return {
        capturedAt: m.capturedAt,
        expiry: m.expiryDate.toISOString().slice(0, 10),
        source: m.source,
        spot: Number.isFinite(spot) && spot > 0 ? spot : null,
        strikes,
      };
    }
    return null;
  }

  private warnOnce(symbol: string, cause: string, detail: string): void {
    const key = `${symbol}:${cause}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.logger.warn(`OI read unavailable for ${symbol}: ${cause} — ${detail}`);
  }
}
