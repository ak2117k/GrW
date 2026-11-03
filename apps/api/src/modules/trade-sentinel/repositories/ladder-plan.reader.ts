import { Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { deriveEngineTargets } from '../../signal-trader/domain/engine-target';
import type { InstrumentKind } from '../../signal-trader/domain/signal.types';
import { ladderTargets, type LadderMode } from '../../exit-discipline/target-ladder';
import type { LadderPlan, LadderPlanReader, LadderPlanRequest } from '../ports/ladder-plans.port';

const SUFFIX = /\d(CE|PE|FUT)$/;
/** How many of the tracker's latest verdicts are scanned for a proposed premium stop. */
const VERDICTS_SCANNED = 50;

/** A stored exitTrigger's PREMIUM stop on the loss side of the entry (BELOW for a long), else null. Pure. */
export function premiumStopOf(raw: unknown, side: 'LONG' | 'SHORT', entry: number): number | null {
  const t = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!t || t.instrument !== 'PREMIUM' || typeof t.price !== 'number' || !Number.isFinite(t.price) || t.price <= 0) return null;
  const long = side === 'LONG';
  if (t.op !== (long ? 'BELOW' : 'ABOVE')) return null;
  return (long ? t.price < entry : t.price > entry) ? t.price : null;
}
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The engine-target kind of a tradingsymbol: CE / PE / FUT by suffix, else a cash share (EQ). */
export function instrumentKindOf(symbol: string): InstrumentKind {
  const m = SUFFIX.exec(String(symbol ?? '').trim().toUpperCase());
  return m ? (m[1] as InstrumentKind) : 'EQ';
}

/**
 * Targets for a MANUAL position (no signal), the way the signal gate sets engine targets
 * (signal-trader/domain/engine-target.ts): the level-book line ahead of the spot carried to the contract
 * (a level closer than 1 R skipped), any slot left as 1.5 R / 2.5 R. Options get the R targets only — the
 * cycle has no delta to carry an underlying level to the premium. Pure.
 */
export function manualLadderPlan(req: LadderPlanRequest, stop: number, source: LadderPlan['source'], why: string): LadderPlan {
  const kind = instrumentKindOf(req.symbol);
  const e = deriveEngineTargets({
    kind,
    side: req.side === 'LONG' ? 'BUY' : 'SELL',
    price: req.entry,
    tick: 0.05,
    spot: req.spot,
    levels: req.levels,
    delta: null,
    sl: stop,
  });
  return { targets: ladderTargets(req.side, req.entry, e.targets), riskStop: stop, source, detail: `engine: ${e.detail}; R from ${why}` };
}

/**
 * READ-ONLY. A real position's targets, first match wins:
 *  1. a LIVE SIGNAL order handed to this tracker (signal_orders.trackerId) — the plan's own targets (the gate
 *     already kept only those ahead of the entry, and filled engine targets when the channel gave none);
 *  2. a MANUAL position: engine targets sized on its known stop — the latest PREMIUM price-trigger stop
 *     proposed on its verdicts (sentinel_verdicts.exitTrigger, the AI's machine-readable stop) when it is on
 *     the loss side of the entry. The armed-trigger table itself is sentinel-executor's and is never read here
 *     (sentinel-executor.structure.spec); an UNDERLYING trigger cannot be carried to the premium (no delta);
 *  3. otherwise on the documented default stop the cycle passes (1 × daily ATR ≈ the contract's 1-min N ×
 *     √375; target-ladder.ts defaultLadderStop). No stop known yet (N unmeasured) ⇒ null, retried later.
 * A broker-side SL order is not read: the sentinel never calls the broker (see the cycle's structure spec).
 */
export class PrismaLadderPlanReader implements LadderPlanReader {
  private readonly logger = new Logger(PrismaLadderPlanReader.name);

  constructor(
    private readonly prisma: PrismaService,
    readonly mode: Exclude<LadderMode, 'off'> = 'on',
  ) {}

  async planFor(req: LadderPlanRequest): Promise<LadderPlan | null> {
    try {
      const order = await this.prisma.signalOrder.findFirst({
        where: { trackerId: req.trackerId, userId: req.userId },
        orderBy: { createdAt: 'desc' },
        select: { targets: true, sl: true, decisionId: true },
      });
      if (order) {
        const targets = ladderTargets(req.side, req.entry, Array.isArray(order.targets) ? (order.targets as unknown[]) : []);
        return { targets, riskStop: order.sl ?? null, source: 'signal', detail: `signal plan (decision ${order.decisionId}): T ${targets.length ? targets.join(' / ') : 'none ahead of the entry'}` };
      }
      const rows = await this.prisma.sentinelVerdict.findMany({
        where: { trackerId: req.trackerId, userId: req.userId },
        orderBy: { createdAt: 'desc' },
        take: VERDICTS_SCANNED,
        select: { exitTrigger: true },
      });
      const p = rows.map((r) => premiumStopOf(r.exitTrigger, req.side, req.entry)).find((x): x is number => x !== null) ?? null;
      if (p !== null) return manualLadderPlan(req, p, 'ai-trigger', `the latest proposed price-trigger stop ${p}`);
      if (req.fallbackStop !== null) {
        return manualLadderPlan(req, req.fallbackStop, 'atr-default', `the default stop ${req.fallbackStop} (no stop on record: 1× daily ATR ≈ 1-min N × √375)`);
      }
      return null;
    } catch (err) {
      this.logger.warn(`[target-ladder] plan read failed for ${req.symbol} (tracker ${req.trackerId}): ${errText(err)} — retried later`);
      return null;
    }
  }
}
