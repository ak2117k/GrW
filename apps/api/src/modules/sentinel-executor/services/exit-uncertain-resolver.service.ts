// apps/api/src/modules/sentinel-executor/services/exit-uncertain-resolver.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { sendOpsAlert } from '../../../common/utils/ops-alert';
import { answeredPositions } from '../../trade-tracker/services/trade-tracker.service';
import type { AutoExitConfig } from '../domain/auto-exit.types';
import { scrubBrokerMessage } from '../domain/exit-failure-alert';
import { istDayStartUtc } from '../domain/exit-order';
import {
  ORDER_NOT_FOUND,
  UNCERTAIN_PER_SWEEP,
  UNCERTAIN_RECHECK_GAP_MS,
  decideUncertain,
  type UncertainDecision,
  type UncertainExitRow,
} from '../domain/uncertain-exit';
import { AiExitExecutionRepository, type AiExitPatch } from '../repositories/ai-exit-execution.repository';
import { OwnerBrokerSessionProvider } from './owner-broker-session.provider';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** In-memory per-row state older than this is dropped (rows are only ever read for the IST day). */
const DAY_MS = 86_400_000;

/**
 * Resolves live exits of UNKNOWN fate (FAILED: ORDER_UNCERTAIN / INTERRUPTED) from
 * the broker's own books (domain/uncertain-exit.ts says why and how).
 *
 * READ-ONLY. It reads the order book and the positions and nothing else: it never
 * places, cancels, modifies or re-sends an order, and never logs in
 * (`allowEphemeralLogin: false` — no warm feed session ⇒ the row waits). A row is
 * moved only while it is STILL FAILED with the reason it was read with. Each row is
 * read at most every UNCERTAIN_RECHECK_GAP_MS, at most UNCERTAIN_PER_SWEEP rows per sweep.
 *
 * Outcomes: our order found ⇒ PLACED / FILLED (the block stays: it exists); our order
 * rejected / cancelled ⇒ REJECTED; not found twice with the position intact ⇒ FAILED:
 * ORDER_NOT_FOUND (no longer blocks — the next verdict or hard exit can act); position
 * gone or changed ⇒ untouched (stays blocking). Every outcome: a loud WARN + an ops alert.
 */
@Injectable()
export class ExitUncertainResolver {
  private readonly logger = new Logger(ExitUncertainResolver.name);
  private readonly checkedAt = new Map<string, number>();
  private readonly firstNotFound = new Map<string, number>();
  /** row id → the outcome already alerted (a blocking outcome is re-checked but alerted once). */
  private readonly alerted = new Map<string, string>();
  private running = false;

  constructor(
    private readonly repo: AiExitExecutionRepository,
    private readonly sessions: OwnerBrokerSessionProvider,
  ) {}

  /** One sweep. Single-flight; never throws. */
  async runOnce(cfg: Pick<AutoExitConfig, 'qtyUnits'>, now: Date = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const nowMs = now.getTime();
      const rows = await this.repo.uncertainSince(istDayStartUtc(now));
      let checked = 0;
      for (const row of rows) {
        if (checked >= UNCERTAIN_PER_SWEEP) break;
        if (nowMs - (this.checkedAt.get(row.id) ?? 0) < UNCERTAIN_RECHECK_GAP_MS) continue;
        this.checkedAt.set(row.id, nowMs);
        checked++;
        try {
          await this.resolveOne(row, cfg, now);
        } catch (err) {
          this.logger.warn(`[ai-exit-resolve] ${row.symbol} row ${row.id}: ${errText(err)}`);
        }
      }
      for (const [id, at] of this.checkedAt) {
        if (nowMs - at > DAY_MS) {
          this.checkedAt.delete(id);
          this.firstNotFound.delete(id);
          this.alerted.delete(id);
        }
      }
    } catch (err) {
      this.logger.warn(`[ai-exit-resolve] sweep failed: ${errText(err)}`);
    } finally {
      this.running = false;
    }
  }

  private async resolveOne(row: UncertainExitRow, cfg: Pick<AutoExitConfig, 'qtyUnits'>, now: Date): Promise<void> {
    const { book, positions } = await this.read(row);
    const exchange = String(row.exchange ?? '').toUpperCase();
    const d = decideUncertain({
      row, book, positions, qtyUnit: cfg.qtyUnits[exchange], nowMs: now.getTime(),
      firstNotFoundAtMs: this.firstNotFound.get(row.id) ?? null,
    });
    await this.apply(row, d, now);
  }

  /** Order book first; positions only if the book answered. Any throw / unanswered envelope ⇒ null. */
  private async read(row: UncertainExitRow): Promise<{ book: unknown[] | null; positions: unknown[] | null }> {
    try {
      return await this.sessions.withOwnerSession(row.userId, async (s) => {
        const book = await this.safe(() => s.getOrderBookEnvelope());
        const positions = book ? await this.safe(() => s.getPositionsEnvelope()) : null;
        return { book, positions };
      }, { allowEphemeralLogin: false });
    } catch (err) {
      this.logger.debug?.(`[ai-exit-resolve] ${row.symbol}: no session (${errText(err)})`);
      return { book: null, positions: null };
    }
  }

  private async safe(read: () => Promise<unknown>): Promise<unknown[] | null> {
    try {
      return answeredPositions(await read());
    } catch {
      return null;
    }
  }

  private async apply(row: UncertainExitRow, d: UncertainDecision, now: Date): Promise<void> {
    const from = String(row.reason ?? '');
    const what = `${row.symbol} (tracker ${row.trackerId}, verdict ${row.verdictId}, was FAILED: ${from})`;
    const note = (detail: string) =>
      `${row.brokerMessage ?? ''}${row.brokerMessage ? ' | ' : ''}resolver ${now.toISOString()}: ${detail}`.slice(0, 1000);

    switch (d.kind) {
      case 'WAIT':
        if (!d.keepStreak) this.firstNotFound.delete(row.id);
        this.logger.debug?.(`[ai-exit-resolve] ${what}: no change (${d.why})`);
        return;
      case 'NOT_FOUND_FIRST':
        this.firstNotFound.set(row.id, now.getTime());
        this.logger.warn(`[ai-exit-resolve] ${what}: ${d.detail} — check 1 of 2; re-checking in ≥${UNCERTAIN_RECHECK_GAP_MS / 1000} s`);
        return;
      case 'NOT_PLACED': {
        this.firstNotFound.delete(row.id);
        const moved = await this.repo.resolveUncertain(row.id, from, {
          reason: ORDER_NOT_FOUND,
          brokerMessage: note(`${d.detail} on 2 checks — the exit order was never placed; exits on this position are unblocked`),
        });
        if (moved) {
          this.loud(row, 'NOT_PLACED',
            `[ai-exit-resolve] !!! ${what}: ${d.detail} on 2 checks — marked FAILED: ${ORDER_NOT_FOUND}. ` +
              `The position is STILL OPEN and exits on it are UNBLOCKED (the next verdict / hard exit can act).`,
            `GrW ALERT: exit of ${row.symbol} was never placed (no order at Angel, position unchanged). ` +
              `Exits on it are unblocked again — the position is STILL OPEN, check it.`);
        }
        return;
      }
      case 'ORDER_FILLED': {
        this.firstNotFound.delete(row.id);
        const moved = await this.repo.resolveUncertain(row.id, from, {
          status: 'FILLED', reason: null, brokerOrderId: d.orderId, orderStatus: 'complete',
          fillPrice: d.fill.averagePrice, fillQty: d.fill.filledQty, fillAt: d.fill.fillAt ?? now,
          brokerMessage: note(`order ${d.orderId} with our tag ${d.tag} is complete`),
        } satisfies Omit<AiExitPatch, 'gate'>);
        if (moved) {
          this.loud(row, 'FILLED',
            `[ai-exit-resolve] ${what}: order ${d.orderId} (tag ${d.tag}) is COMPLETE @ ${d.fill.averagePrice ?? '?'} — marked FILLED`,
            `GrW: exit of ${row.symbol} whose answer was lost DID go through — order ${d.orderId} filled @ ${d.fill.averagePrice ?? '?'}.`);
        }
        return;
      }
      case 'ORDER_LIVE': {
        this.firstNotFound.delete(row.id);
        const moved = await this.repo.resolveUncertain(row.id, from, {
          status: 'PLACED', reason: null, brokerOrderId: d.orderId || null, orderStatus: d.status,
          brokerMessage: note(`order ${d.orderId || '?'} with our tag ${d.tag} is ${d.status}`),
        });
        if (moved) {
          this.loud(row, 'PLACED',
            `[ai-exit-resolve] ${what}: order ${d.orderId || '?'} (tag ${d.tag}) is ${d.status} at Angel — marked PLACED (exits stay blocked while it works)`,
            `GrW: exit of ${row.symbol} whose answer was lost IS at Angel — order ${d.orderId || '?'} ${d.status}. Exits on it stay blocked while it works.`);
        }
        return;
      }
      case 'ORDER_DEAD': {
        this.firstNotFound.delete(row.id);
        const moved = await this.repo.resolveUncertain(row.id, from, {
          status: 'REJECTED', reason: d.status === 'cancelled' ? 'CANCELLED' : 'BROKER_REJECTED', orderStatus: d.status,
          brokerOrderId: d.orderId || null,
          brokerMessage: note(`order ${d.orderId || '?'} with our tag ${d.tag} was ${d.status}${d.text ? `: ${d.text}` : ''}`),
        });
        if (moved) {
          this.loud(row, 'REJECTED',
            `[ai-exit-resolve] !!! ${what}: order ${d.orderId || '?'} (tag ${d.tag}) was ${d.status} at Angel — marked REJECTED; ` +
              `the position was NOT exited and exits on it are UNBLOCKED`,
            `GrW ALERT: exit of ${row.symbol} was ${d.status} at Angel (${scrubBrokerMessage(d.text)}). ` +
              `The position is STILL OPEN; exits on it are unblocked again — check it.`);
        }
        return;
      }
      case 'POSITION_CHANGED':
        this.firstNotFound.delete(row.id);
        this.loud(row, 'POSITION_CHANGED',
          `[ai-exit-resolve] !!! ${what}: no order with our tag in the book but ${d.detail} — the exit order (or the owner) ` +
            `may have closed it. Left FAILED: ${from}: exits on this position STAY BLOCKED today. Check Angel.`,
          `GrW ALERT: exit of ${row.symbol} had a lost answer; no order of ours in Angel's book, but ${d.detail}. ` +
            `Exits on it STAY BLOCKED today — check the position at Angel.`);
        return;
    }
  }

  /**
   * One loud WARN + one ops alert per row and outcome (never credentials). A blocking
   * outcome (POSITION_CHANGED) is re-checked every sweep; its repeats are debug only.
   */
  private loud(row: UncertainExitRow, outcome: string, line: string, alert: string): void {
    if (this.alerted.get(row.id) === outcome) {
      this.logger.debug?.(line);
      return;
    }
    this.logger.warn(line);
    this.alerted.set(row.id, outcome);
    void sendOpsAlert(`ai-exit-resolve:${row.id}:${outcome}`, alert).catch(() => undefined);
  }
}
