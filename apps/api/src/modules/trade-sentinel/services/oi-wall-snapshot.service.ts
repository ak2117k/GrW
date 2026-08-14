import { Injectable } from '@nestjs/common';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly oiWall: OiWallService,
  ) {}

  /**
   * @param expiry Storage key only — it segregates snapshot lineages so a
   *   rollover does not diff this expiry's walls against last expiry's. It is
   *   NOT passed to `OiWallService`, which always reads the nearest expiry
   *   itself; callers should pass the nearest expiry to keep the two aligned.
   * @param underlyingLtp Spot price of the underlying. `OiWallService.walls`
   *   uses it to keep only OTM strikes — an ITM high-OI strike is not a wall.
   *   Passing 0 (or omitting it) disables that filter rather than erroring.
   */
  async captureAndCompare(
    symbol: string,
    expiry: string,
    underlyingLtp = 0,
  ): Promise<{ now: WallPair | null; prev: WallPair | null }> {
    const walls = await this.oiWall.walls(symbol, underlyingLtp);
    if (!walls || walls.length === 0) {
      // Cash stocks have no chain, and `walls()` never throws — it returns [].
      // Not an error, just nothing to compare.
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

    // callWallOi/putWallOi are left unset: `LevelCandidate` carries only a rank
    // score (30/20), never the open-interest figure, so there is no honest value
    // to put in those columns. Writing the score there would be a lie.
    await this.prisma.oiWallSnapshot.create({
      data: { symbol, expiry, callWall: now.callWall, putWall: now.putWall },
    });

    return {
      now,
      prev: previous ? { callWall: previous.callWall, putWall: previous.putWall } : null,
    };
  }
}
