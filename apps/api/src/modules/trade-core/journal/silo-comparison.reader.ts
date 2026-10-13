import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { CorePositionRepository } from '../lifecycle/repositories/core-position.repository';
import { CoreJournalRepository } from './repositories/core-journal.repository';
import { CoreTradeSummaryRepository } from './repositories/core-trade-summary.repository';

export interface ComparisonRow {
  alertId: string;
  symbol: string | null;
  token: string;
  strategyKey: string;
  intentId: string;
  core: { outcome: 'TRADED' | 'OPEN' | 'SKIPPED' | 'PENDING'; reason: string | null; netPnl: string | null; qty: number | null };
  silo: { track: 'adaptive-stop' | 'ungated'; status: string; pnl: number | null; fees: number | null; exitReason: string | null } | null;
}

type SiloEntry = { alertId: string | null; token: string; status: string; paperTradeId: string | null };
type SiloTrade = { id: string; pnl: number | null; fees: number; exitReasonTag: string | null; status: string };

/**
 * Spec §8.4 comparison view (J21): the core result beside the old silo's for the same Chartink alert.
 * Read-only on the silo tables (approach A), admin-only (they are platform-wide, not per user).
 */
@Injectable()
export class SiloComparisonReader {
  constructor(
    private readonly prisma: PrismaService,
    private readonly journal: CoreJournalRepository,
    private readonly summaries: CoreTradeSummaryRepository,
    private readonly positions: CorePositionRepository,
  ) {}

  async forDay(userId: string, day: string): Promise<ComparisonRow[]> {
    const rows = await this.journal.listForDay(userId, day, ['ALERT_RECEIVED', 'INTENT_SKIPPED']);
    const setups = rows.filter((r) => r.type === 'ALERT_RECEIVED' && r.intentId);
    if (setups.length === 0) return [];
    const skipOf = new Map(rows.filter((r) => r.type === 'INTENT_SKIPPED').map((r) => [r.intentId, r]));
    const tradeOf = new Map((await this.summaries.listForDay(userId, day)).map((s) => [s.intentId, s]));
    const alertIds = [...new Set(setups.map((r) => String(r.payload.alertId)))];
    const silo = {
      'adaptive-stop': await this.silo(alertIds, this.prisma.adaptiveStopWatchEntry, this.prisma.adaptiveStopTrade),
      ungated: await this.silo(alertIds, this.prisma.ungatedWatchEntry, this.prisma.ungatedTrade),
    } as const;
    const out: ComparisonRow[] = [];
    for (const r of setups) {
      const intentId = r.intentId as string;
      const alertId = String(r.payload.alertId);
      const token = String(r.payload.token);
      const strategyKey = String(r.payload.strategyKey ?? '');
      const trade = tradeOf.get(intentId);
      const skip = skipOf.get(intentId);
      let core: ComparisonRow['core'];
      if (trade) core = { outcome: 'TRADED', reason: trade.exitReason, netPnl: trade.netPnl, qty: trade.qty };
      else if (skip) core = { outcome: 'SKIPPED', reason: String(skip.payload.reason ?? 'UNKNOWN'), netPnl: null, qty: null };
      else {
        // findByIntent is a global read (the intent id is unique): refuse another user's row.
        const found = await this.positions.findByIntent(intentId);
        const pos = found && found.userId === userId ? found : null;
        core = pos ? { outcome: 'OPEN', reason: pos.status, netPnl: null, qty: pos.entryFilledQty } : { outcome: 'PENDING', reason: null, netPnl: null, qty: null };
      }
      const track = strategyKey === 'adaptive-stop' || strategyKey === 'ungated' ? strategyKey : null;
      const s = track ? silo[track].get(`${alertId}|${token}`) : undefined;
      out.push({ alertId, symbol: r.symbol, token, strategyKey, intentId, core, silo: s && track ? { track, ...s } : null });
    }
    return out;
  }

  private async silo(
    alertIds: string[],
    entries: { findMany(args: unknown): Promise<unknown[]> },
    trades: { findMany(args: unknown): Promise<unknown[]> },
  ): Promise<Map<string, { status: string; pnl: number | null; fees: number | null; exitReason: string | null }>> {
    const es = (await entries.findMany({ where: { alertId: { in: alertIds } }, select: { alertId: true, token: true, status: true, paperTradeId: true } })) as SiloEntry[];
    const ids = es.map((e) => e.paperTradeId).filter((x): x is string => x !== null);
    const ts = ids.length ? ((await trades.findMany({ where: { id: { in: ids } }, select: { id: true, pnl: true, fees: true, exitReasonTag: true, status: true } })) as SiloTrade[]) : [];
    const tradeById = new Map(ts.map((t) => [t.id, t]));
    const out = new Map<string, { status: string; pnl: number | null; fees: number | null; exitReason: string | null }>();
    for (const e of es) {
      const t = e.paperTradeId ? tradeById.get(e.paperTradeId) : undefined;
      out.set(`${e.alertId}|${e.token}`, { status: String(e.status), pnl: t?.pnl ?? null, fees: t?.fees ?? null, exitReason: t?.exitReasonTag ?? null });
    }
    return out;
  }
}
