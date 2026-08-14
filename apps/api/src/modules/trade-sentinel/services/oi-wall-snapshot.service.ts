import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { OiWallService } from '../../signal-generator/services/oi-wall.service';

export interface WallPair {
  callWall: number | null;
  putWall: number | null;
}

/**
 * `OiWallService` answers "where are the walls right now". Detecting a wall
 * SHIFT needs history, and nothing stored it — so this service captures each
 * reading and hands back the previous one alongside the new.
 *
 * Read-then-write ordering is load-bearing: writing first would make every
 * comparison compare a reading against itself, and the shift sensor would go
 * permanently silent in a way that looks exactly like "the walls never move".
 */
@Injectable()
export class OiWallSnapshotService {
  private readonly logger = new Logger(OiWallSnapshotService.name);

  /**
   * Symbols already warned about, so a per-tick poll reports a missing chain
   * ONCE rather than every poll. Keyed by symbol+cause so a changed cause is
   * still reported. Mirrors the pattern in `OiWallService`.
   */
  private readonly warned = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly oiWall: OiWallService,
  ) {}

  private warnOnce(symbol: string, cause: string, detail: string): void {
    const key = `${symbol}:${cause}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.logger.warn(`OI wall snapshot skipped for ${symbol}: ${cause} — ${detail}`);
  }

  /**
   * @param expiry Storage key only — it segregates snapshot lineages so a
   *   rollover does not diff this expiry's walls against last expiry's. It is
   *   NOT passed to `OiWallService`, which always reads the nearest expiry
   *   itself; callers should pass the nearest expiry to keep the two aligned.
   * @param underlyingLtp Spot price of the underlying, or null when it is
   *   unavailable. Required — not defaulted — because `OiWallService.walls`
   *   uses it to keep only OTM strikes, and a missing/zero spot disables that
   *   filter and yields ITM strikes labelled as walls. Those would be WRITTEN
   *   to the snapshot table, so the next correctly-sided capture would diff
   *   against a mis-sided stored reading and emit a large spurious shift. A
   *   persisted false positive outlives the bad call that made it, so on a
   *   null/non-positive spot this stores nothing and returns nothing — the
   *   same "stay silent rather than fall back" rule the sensors follow
   *   (see `tripwires/types.ts`).
   */
  async captureAndCompare(
    symbol: string,
    expiry: string,
    underlyingLtp: number | null,
  ): Promise<{ now: WallPair | null; prev: WallPair | null }> {
    if (underlyingLtp === null || underlyingLtp <= 0) {
      this.warnOnce(
        symbol,
        'no underlying spot',
        'walls cannot be sided OTM without one, and storing an unsided reading would poison the next comparison',
      );
      return { now: null, prev: null };
    }

    const walls = await this.oiWall.walls(symbol, underlyingLtp);
    if (!walls || walls.length === 0) {
      // `walls()` never throws — it returns [] for THREE different situations
      // that are indistinguishable from here: a cash stock genuinely having no
      // chain (a fact), a chain fetch that failed (logged only at debug inside
      // that service), and the options-chain service not being wired at all.
      // So this is NOT safely "just nothing to compare": a permanently failing
      // chain would otherwise leave this sensor silent forever with no trace.
      // Warn once per symbol, and say that the cause is ambiguous.
      this.warnOnce(
        symbol,
        'no OI walls returned',
        'cause is indistinguishable between no chain (cash stock), a failed chain fetch, and an unwired options-chain service',
      );
      return { now: null, prev: null };
    }

    // `walls()` returns up to two strikes per side, already ordered by OI
    // descending (score 30 then 20), so the first of each kind is the wall.
    const call = walls.find((w) => w.kind === 'OI_CALL');
    const put = walls.find((w) => w.kind === 'OI_PUT');
    const now: WallPair = { callWall: call?.price ?? null, putWall: put?.price ?? null };

    const previous = await this.prisma.oiWallSnapshot.findFirst({
      where: { symbol, expiry },
      orderBy: { capturedAt: 'desc' },
    });

    const prev = previous ? { callWall: previous.callWall, putWall: previous.putWall } : null;

    // An unchanged reading is not worth a row. `prev` is always "the last STORED
    // reading", so collapsing a run of identical readings into the first of them
    // leaves every future `prev` VALUE exactly as it would have been — the only
    // thing that changes is that the retained row's `capturedAt` is the moment
    // the walls last MOVED, which is the more useful timestamp anyway. At a
    // per-tick poll this is the difference between a row every few seconds and a
    // row per actual wall move.
    //
    // Retention of the rows that remain is Task 12's — `daily-housekeeping`
    // already exists for exactly this and nothing here should grow its own.
    const unchanged = prev !== null && prev.callWall === now.callWall && prev.putWall === now.putWall;
    if (!unchanged) {
      // callWallOi/putWallOi are left unset: `LevelCandidate` carries only a rank
      // score (30/20), never the open-interest figure, so there is no honest value
      // to put in those columns. Writing the score there would be a lie.
      await this.prisma.oiWallSnapshot.create({
        data: { symbol, expiry, callWall: now.callWall, putWall: now.putWall },
      });
    }

    return { now, prev };
  }
}
