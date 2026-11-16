import type { PrismaService } from '../../common/prisma/prisma.service';
import { ladderTargets, parseLadderMode, type LadderMode } from '../exit-discipline/target-ladder';
import type { LadderPlan, LadderPlanReader, LadderPlanRequest } from '../trade-sentinel/ports/ladder-plans.port';
import { tradeIdOf } from '../trade-sentinel/paper/paper-tracker';

/**
 * PAPER target ladder + profit lock (owner 2026-11-16, correctness review F4). Until today the ladder and
 * the profit lock (13 Nov) ran on REAL positions only; on paper the giveback / trail floor were shadow
 * lines, so GOLD 135000 PE went +₹5,760 → −₹5,286 with "shadow GIVEBACK" logged and nothing done. The paper
 * trade's own plan (trades.stoploss / trades.target) sets the targets; with no target, the stop on record
 * (else the default 1× daily ATR stop) sizes R targets like a manual position. PAPER_LADDER: on (default) |
 * observe | off. Never rejects on a data gap (null = retried later).
 */
export class PaperLadderPlanReader implements LadderPlanReader {
  constructor(
    private readonly prisma: Pick<PrismaService, 'trade'>,
    readonly mode: Exclude<LadderMode, 'off'> = 'on',
  ) {}

  async planFor(req: LadderPlanRequest): Promise<LadderPlan | null> {
    try {
      const t = await this.prisma.trade.findUnique({ where: { id: tradeIdOf(req.trackerId) }, select: { stoploss: true, target: true } });
      const sl = t?.stoploss !== null && t?.stoploss !== undefined && Number(t.stoploss) > 0 ? Number(t.stoploss) : null;
      const targets = ladderTargets(req.side, req.entry, t?.target !== null && t?.target !== undefined ? [Number(t.target)] : []);
      if (targets.length) return { targets, riskStop: sl, source: 'signal', detail: `paper plan: T ${targets.join(' / ')}${sl !== null ? `, SL ${sl}` : ''}` };
      if (sl !== null) return rPlan(req, sl, 'ai-trigger', `the paper trade's stop ${sl} (no target on record)`);
      if (req.fallbackStop !== null) return rPlan(req, req.fallbackStop, 'atr-default', `the default stop ${req.fallbackStop} (no stop on record)`);
      return null;
    } catch {
      return null;
    }
  }
}

/**
 * 1.5 R / 2.5 R targets from a stop (the manual-position R slots). Local on purpose: the shared manual planner
 * imports the signal-trader domain, which reaches order code — the paper sentinel must not (structural spec).
 */
function rPlan(req: LadderPlanRequest, stop: number, source: LadderPlan['source'], why: string): LadderPlan | null {
  const r = req.side === 'LONG' ? req.entry - stop : stop - req.entry;
  if (!(r > 0)) return null;
  const at = (k: number) => Math.round((req.side === 'LONG' ? req.entry + k * r : req.entry - k * r) * 20) / 20;
  const targets = ladderTargets(req.side, req.entry, [at(1.5), at(2.5)]);
  return targets.length ? { targets, riskStop: stop, source, detail: `${why}: T ${targets.join(' / ')} (1.5 R / 2.5 R)` } : null;
}

/** PAPER_LADDER → a reader, or undefined (off). */
export function paperLadderFrom(prisma: Pick<PrismaService, 'trade'>, raw: string | undefined): PaperLadderPlanReader | undefined {
  const mode = parseLadderMode(raw);
  return mode === 'off' ? undefined : new PaperLadderPlanReader(prisma, mode);
}
