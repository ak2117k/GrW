import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SessionClock } from '../../market-hub/session-clock';
import { istMidnightOf, istYmd, lastSessionDates } from '../../night-report/domain/night-report.logic';
import { evaluateSignalOutcome, type OutcomeBar } from '../domain/outcome';
import type { EntryType, Side } from '../domain/types';
import type { SignalIntakeRepository } from '../repositories/signal-intake.repository';
import { SIGNAL_INTAKE_CONFIG, type SignalIntakeConfig } from '../signal-intake.config';

export const SIGNAL_OUTCOME_REPO = Symbol('SIGNAL_OUTCOME_REPO');
export const SIGNAL_OUTCOME_BARS = Symbol('SIGNAL_OUTCOME_BARS');
export const SIGNAL_CLOCK = Symbol('SIGNAL_CLOCK');

/** 5-minute bars of one contract over the owner's own Angel session. */
export interface OutcomeBars {
  fetch(exchange: string, token: string, from: Date, to: Date): Promise<OutcomeBar[]>;
}

/** Sessions an outcome is waited for: intraday = the session of the post, BTST / positional = 3. */
export const HORIZON_SESSIONS: Record<string, number> = { INTRADAY: 1, BTST: 3, POSITIONAL: 3 };
/** Signals posted within this many closed NSE sessions are (re)tried. */
const LOOKBACK_SESSIONS = 6;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * After the close (cron 16:20 IST, before the 18:45 self-review run) replay every parsed signal whose
 * horizon has ended on its own contract's 5-minute bars and store TARGET1 / SL / NEITHER /
 * NOT_TRIGGERED / NO_DATA / UNRESOLVED on the row. The self-review kind CHANNEL_SIGNAL reads these
 * (its session = `outcomeSession`). Traded or not, every signal is scored.
 */
@Injectable()
export class SignalOutcomeService {
  private readonly logger = new Logger(SignalOutcomeService.name);

  constructor(
    @Inject(SIGNAL_OUTCOME_REPO) private readonly repo: Pick<SignalIntakeRepository, 'unfilled' | 'fillOutcome'>,
    @Inject(SIGNAL_OUTCOME_BARS) private readonly bars: OutcomeBars,
    @Inject(SIGNAL_CLOCK) private readonly clock: SessionClock,
    @Inject(SIGNAL_INTAKE_CONFIG) private readonly config: SignalIntakeConfig,
  ) {}

  /** Close instant of session `s` (IST date) on `exchange`; null when it is no trading day there. */
  private closeOf(s: string, exchange: string): Date | null {
    const midnight = istMidnightOf(s);
    const w = this.clock.tradingWindow(exchange, new Date(midnight.getTime() + 12 * 3_600_000));
    return w ? new Date(midnight.getTime() + w.closeMin * 60_000) : null;
  }

  async fillOutcomes(now: Date = new Date()): Promise<{ filled: number; pending: number }> {
    if (!this.config.outcomesEnabled) return { filled: 0, pending: 0 };
    const closed = lastSessionDates(now, this.clock, LOOKBACK_SESSIONS + 3).reverse(); // ascending
    if (closed.length === 0) return { filled: 0, pending: 0 };
    const rows = await this.repo.unfilled(closed[Math.max(0, closed.length - 1 - LOOKBACK_SESSIONS)], closed[closed.length - 1]);
    let filled = 0;
    let pending = 0;
    for (const s of rows) {
      try {
        const exchange = s.exchange ?? (s.instrumentKind === 'EQ' ? 'NSE' : 'NFO');
        const venue = exchange === 'MCX' ? 'MCX' : 'NSE';
        const start = closed.findIndex((d) => {
          const c = this.closeOf(d, venue);
          return c !== null && c.getTime() > s.receivedAt.getTime();
        });
        const endIdx = start < 0 ? -1 : start + (HORIZON_SESSIONS[s.horizon] ?? 1) - 1;
        if (start < 0 || endIdx >= closed.length) {
          pending++;
          continue;
        }
        const endSession = closed[endIdx];
        const end = this.closeOf(endSession, venue) ?? new Date(istMidnightOf(endSession).getTime() + 86_400_000);
        if (end.getTime() > now.getTime()) {
          pending++;
          continue;
        }
        if (!s.token) {
          await this.repo.fillOutcome(s.id, { status: 'UNRESOLVED', session: endSession, entryAt: null, exitAt: null, details: { why: 'no contract token at intake' } }, now);
          filled++;
          continue;
        }
        const bars = await this.bars.fetch(exchange, s.token, s.receivedAt, end);
        const targets = Array.isArray(s.targets) ? (s.targets as unknown[]).map(Number).filter((x) => Number.isFinite(x)) : [];
        const o = evaluateSignalOutcome(
          { side: s.side as Side, entryType: s.entryType as EntryType, entryLow: s.entryLow, entryHigh: s.entryHigh, sl: s.sl, targets },
          // Only bars that START after the post: an earlier bar's range includes prices from before the call.
          bars.filter((b) => b.ts >= s.receivedAt.getTime() && b.ts < end.getTime()),
        );
        const session = o.exitAt !== null ? istYmd(new Date(o.exitAt)) : endSession;
        await this.repo.fillOutcome(
          s.id,
          {
            status: o.status,
            session: closed.includes(session) ? session : endSession,
            entryAt: o.entryAt !== null ? new Date(o.entryAt) : null,
            exitAt: o.exitAt !== null ? new Date(o.exitAt) : null,
            details: { exitPrice: o.exitPrice, bars: bars.length, endSession, horizon: s.horizon, t1: targets[0] ?? null, sl: s.sl },
          },
          now,
        );
        filled++;
      } catch (e) {
        pending++;
        this.logger.warn(`[signal-intake] outcome for signal ${s.id} failed: ${errText(e)}`);
      }
    }
    if (rows.length) this.logger.log(`[signal-intake] outcomes: ${filled} filled, ${pending} pending`);
    return { filled, pending };
  }
}
