import { Injectable } from '@nestjs/common';
import { istDateOf } from '../../../common/utils/contract-expiry';
import { buildBoard, type SignalBoard } from '../domain/signal-board';
import { SignalBoardRepository } from '../repositories/signal-board.repository';

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
/** The window opens at the previous day's NSE close: the night's analysis belongs to the next session. */
const OPEN_AFTER_CLOSE_MIN = 15 * 60 + 30;

/** UTC instant of `ymd` 00:00 IST. */
export function istMidnight(ymd: string): Date {
  return new Date(Date.parse(`${ymd}T00:00:00.000Z`) - IST_OFFSET_MS);
}

/** [previous day 15:30 IST, the day's end): the night run before a session and everything in it. */
export function boardWindow(session: string): { from: Date; to: Date } {
  const midnight = istMidnight(session).getTime();
  return { from: new Date(midnight - DAY_MS + OPEN_AFTER_CLOSE_MIN * 60_000), to: new Date(midnight + DAY_MS) };
}

@Injectable()
export class SignalBoardService {
  constructor(private readonly repo: SignalBoardRepository) {}

  async board(userId: string, date: string | undefined, now = new Date()): Promise<SignalBoard> {
    const session = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : istDateOf(now);
    const { from, to } = boardWindow(session);
    const [setups, ideas, calls, watches] = await Promise.all([
      this.repo.setups(userId, session),
      this.repo.ideas(from, to),
      this.repo.calls(userId, from, to),
      this.repo.watches(from, to),
    ]);
    return buildBoard(session, { setups, ideas: ideas.rows, ideaIdsWithSetup: ideas.withSetup, calls, watches });
  }
}
