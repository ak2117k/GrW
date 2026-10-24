import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { SessionClock } from '../../market-hub/session-clock';
import { INDEX_UNDERLYINGS } from '../../market-hub/underlying';
import { findContract, listedExpiries } from '../domain/contract';
import { asInfoItems } from '../domain/info';
import { judgeInfoItem, type DailyBar, type InfoItemOutcome } from '../domain/info-outcome';
import type { Vocabulary } from '../domain/vocabulary';
import { istMidnightOf, istYmd, lastSessionDates } from '../../night-report/domain/night-report.logic';
import { evaluateSignalOutcome, type OutcomeBar } from '../domain/outcome';
import type { EntryType, Side } from '../domain/types';
import type { SignalIntakeRepository } from '../repositories/signal-intake.repository';
import { SIGNAL_INTAKE_CONFIG, type SignalIntakeConfig } from '../signal-intake.config';

export const SIGNAL_OUTCOME_REPO = Symbol('SIGNAL_OUTCOME_REPO');
export const SIGNAL_OUTCOME_BARS = Symbol('SIGNAL_OUTCOME_BARS');
export const SIGNAL_CLOCK = Symbol('SIGNAL_CLOCK');
export const SIGNAL_INFO_BARS = Symbol('SIGNAL_INFO_BARS');
/** Same tokens as signal-intake.service (re-declared to keep this file free of the service import). */
export const SIGNAL_INFO_MASTER = Symbol('SIGNAL_INFO_MASTER');
export const SIGNAL_INFO_VOCAB = Symbol('SIGNAL_INFO_VOCAB');

/** Daily bars of one instrument over the owner's own Angel session. */
export interface InfoBars {
  daily(exchange: string, token: string, from: Date, to: Date): Promise<DailyBar[]>;
}

/** INFO rows posted within this many days are (re)tried; an item still PENDING after INFO_PENDING_DAYS is NO_DATA. */
const INFO_LOOKBACK_DAYS = 30;
const INFO_PENDING_DAYS = 15;
/** Daily bars fetched per instrument per run: the lookback + 14-bar ATR + holidays. */
const INFO_BARS_DAYS = 80;
const DAY_MS = 86_400_000;
/** Session close (IST minutes) per venue for "posted after the close". */
const CLOSE_MIN: Record<string, number> = { NSE: 15 * 60 + 30, MCX: 23 * 60 + 30 };

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
    @Inject(SIGNAL_OUTCOME_REPO) private readonly repo: Pick<SignalIntakeRepository, 'unfilled' | 'fillOutcome'> & Partial<Pick<SignalIntakeRepository, 'unfilledInfos' | 'fillInfoOutcome'>>,
    @Inject(SIGNAL_OUTCOME_BARS) private readonly bars: OutcomeBars,
    @Inject(SIGNAL_CLOCK) private readonly clock: SessionClock,
    @Inject(SIGNAL_INTAKE_CONFIG) private readonly config: SignalIntakeConfig,
    @Optional() @Inject(SIGNAL_INFO_BARS) private readonly infoBars?: InfoBars,
    @Optional() @Inject(SIGNAL_INFO_MASTER) private readonly master?: { rows(): Promise<readonly unknown[] | null> },
    @Optional() @Inject(SIGNAL_INFO_VOCAB) private readonly vocab?: { get(): Promise<Vocabulary> },
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

  // ─── CHANNEL_INFO (INFO items on daily bars) ─────────────────────────────

  /**
   * After the close: every INFO row's items judged on the underlying's daily bars (domain/info-outcome):
   * NIFTY / BANKNIFTY / … on the index, stocks on NSE cash, CRUDEOIL & co. on the nearest MCX future.
   * A row is filled once every item is final (an item still pending after INFO_PENDING_DAYS → NO_DATA);
   * `outcomeSession` = the latest judged session, the self-review reads CHANNEL_INFO by it.
   */
  async fillInfoOutcomes(now: Date = new Date()): Promise<{ filled: number; pending: number }> {
    const repo = this.repo;
    if (!this.config.outcomesEnabled || !this.infoBars || !repo.unfilledInfos || !repo.fillInfoOutcome) return { filled: 0, pending: 0 };
    const rows = await repo.unfilledInfos(new Date(now.getTime() - INFO_LOOKBACK_DAYS * DAY_MS));
    if (rows.length === 0) return { filled: 0, pending: 0 };
    let master: readonly unknown[] | null = null;
    try {
      master = (await this.master?.rows()) ?? null;
    } catch (e) {
      this.logger.warn(`[signal-intake] instrument master unavailable for INFO outcomes (stocks / MCX skipped): ${errText(e)}`);
    }
    const vocab = (await this.vocab?.get().catch(() => null)) ?? null;
    const bars = new Map<string, Promise<DailyBar[]>>();
    const from = new Date(now.getTime() - INFO_BARS_DAYS * DAY_MS);
    const barsOf = (exchange: string, token: string) => {
      const k = `${exchange}:${token}`;
      let hit = bars.get(k);
      if (!hit) {
        hit = (this.infoBars as InfoBars).daily(exchange, token, from, now).catch((e) => {
          this.logger.warn(`[signal-intake] daily bars ${k} failed: ${errText(e)}`);
          return [];
        });
        bars.set(k, hit);
      }
      return hit;
    };
    let filled = 0;
    let pending = 0;
    for (const r of rows) {
      try {
        const items = asInfoItems(r.items);
        const outs: InfoItemOutcome[] = [];
        for (const item of items) {
          const ref = infoRefOf(item.underlying, vocab, master, r.postedAt);
          if (!ref) {
            outs.push({ status: 'NO_DATA', session: null, baseClose: null, judgedClose: null, ret: null, band: null, levelHit: null });
            continue;
          }
          const venue = ref.exchange === 'MCX' ? 'MCX' : 'NSE';
          const ist = new Date(r.postedAt.getTime() + 330 * 60_000);
          const post = { day: istYmd(r.postedAt), afterClose: ist.getUTCHours() * 60 + ist.getUTCMinutes() >= CLOSE_MIN[venue] };
          outs.push(judgeInfoItem(item, await barsOf(ref.exchange, ref.token), post));
        }
        const stale = now.getTime() - r.postedAt.getTime() > INFO_PENDING_DAYS * DAY_MS;
        if (outs.some((o) => o.status === 'PENDING') && !stale) {
          pending++;
          continue;
        }
        const final = outs.map((o) => (o.status === 'PENDING' ? { ...o, status: 'NO_DATA' as const } : o));
        const sessions = final.map((o) => o.session).filter((x): x is string => !!x).sort();
        await repo.fillInfoOutcome(r.id, final, sessions.length ? sessions[sessions.length - 1] : istYmd(r.postedAt), now);
        filled++;
      } catch (e) {
        pending++;
        this.logger.warn(`[signal-intake] INFO outcome for ${r.id} failed: ${errText(e)}`);
      }
    }
    this.logger.log(`[signal-intake] INFO outcomes: ${filled} filled, ${pending} pending`);
    return { filled, pending };
  }
}

/** Where an INFO item's underlying trades: the index, the NSE cash stock, or the nearest MCX future. */
export function infoRefOf(underlying: string, vocab: Vocabulary | null, master: readonly unknown[] | null, postedAt: Date): { exchange: string; token: string } | null {
  const idx = INDEX_UNDERLYINGS[underlying];
  if (idx) return { exchange: idx.exchange, token: idx.token };
  if (!master) return null;
  const cls = vocab?.classOf.get(underlying);
  if (cls === 'COMMODITY') {
    const day = istYmd(postedAt);
    const expiry = listedExpiries(master, underlying, 'FUT', 'MCX').find((e) => e >= day) ?? null;
    const c = expiry ? findContract(master, { underlying, instrumentKind: 'FUT', strike: null, expiry }, 'MCX') : null;
    return c ? { exchange: c.exchange, token: c.token } : null;
  }
  const c = findContract(master, { underlying, instrumentKind: 'EQ', strike: null, expiry: null }, 'NSE');
  return c ? { exchange: c.exchange, token: c.token } : null;
}
