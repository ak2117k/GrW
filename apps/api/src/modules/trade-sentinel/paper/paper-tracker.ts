/**
 * Paper sentinel tracker ids (docs/superpowers/specs/2026-10-28-paper-exit-shadow-design.md, stage 2).
 * A paper trade has no trade_trackers row; the sentinel cycle keys everything (state, thesis, looks)
 * by `paper:<tradeId>`, which can never collide with a cuid tracker id.
 */
export const PAPER_TRACKER_PREFIX = 'paper:';

export const paperTrackerId = (tradeId: string): string => `${PAPER_TRACKER_PREFIX}${tradeId}`;

export const isPaperTracker = (trackerId: string | null | undefined): boolean =>
  typeof trackerId === 'string' && trackerId.startsWith(PAPER_TRACKER_PREFIX);

export const tradeIdOf = (trackerId: string): string => trackerId.slice(PAPER_TRACKER_PREFIX.length);
