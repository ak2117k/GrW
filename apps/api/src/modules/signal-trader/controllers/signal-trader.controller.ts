import { Controller, ForbiddenException, Get } from '@nestjs/common';
import { AdminOnly, CurrentUser, type AuthenticatedUser } from '../../../common/decorators';
import { SignalTraderRepository } from '../repositories/signal-trader.repository';
import { SignalTraderService } from '../services/signal-trader.service';
import { istDayStart, slEnforceability } from '../domain/execution';

/** Owner only: ADMIN role AND, when HUB_OWNER_USER_ID is set, that exact user. */
export function ownerAllowed(user: Pick<AuthenticatedUser, 'userId' | 'role'> | undefined, ownerUserId: string | null): boolean {
  if (!user?.userId || user.role !== 'ADMIN') return false;
  return ownerUserId ? user.userId === ownerUserId : true;
}

/**
 * /api/signal-trader — read-only view for the "Telegram signals" page. Nothing here places,
 * cancels or changes anything; the mode and caps come from env only.
 */
@Controller('api/signal-trader')
export class SignalTraderController {
  constructor(
    private readonly repo: SignalTraderRepository,
    private readonly trader: SignalTraderService,
  ) {}

  @AdminOnly()
  @Get('overview')
  async overview(@CurrentUser() user?: AuthenticatedUser) {
    const cfg = this.trader.config;
    if (!ownerAllowed(user, cfg.ownerUserId)) throw new ForbiddenException('owner only');
    const now = new Date();
    const since = istDayStart(now);
    const [decisions, orders, byChannel] = await Promise.all([
      this.repo.decisionsSince(since),
      this.repo.ordersSince(since),
      this.repo.allChannelStats().catch(() => null),
    ]);
    const trackers = await this.repo.trackersByIds(orders.map((o) => o.trackerId).filter((x): x is string => !!x));
    const tById = new Map(trackers.map((t) => [t.id, t]));
    const channelIds = [...new Set([...decisions.map((d) => d.channelId), ...Object.keys(byChannel ?? {})].filter((x): x is string => !!x))];
    const titles = new Map((await this.repo.channelTitles(channelIds)).map((c) => [c.id, c.title]));
    const sl = slEnforceability(process.env, cfg.ownerUserId, 'NFO', null);
    return {
      mode: cfg.mode,
      caps: {
        maxLots: cfg.maxLots,
        maxLossPerTrade: cfg.maxLossPerTrade,
        maxTradesPerDay: cfg.maxTradesPerDay,
        dailyLossStop: cfg.dailyLossStop,
        entryTolerancePct: cfg.entryTolerancePct,
        product: cfg.product,
      },
      slEnforcement: { ok: sl.ok, detail: sl.detail },
      decisions: decisions.map((d) => ({
        id: d.id,
        signalId: d.signalId,
        evaluation: d.evaluation,
        decidedAt: d.decidedAt,
        mode: d.mode,
        status: d.status,
        channel: d.channelId ? (titles.get(d.channelId) ?? d.channelId) : null,
        underlying: d.underlying,
        agreeCount: d.agreeCount,
        conflict: d.conflict,
        decision: d.decision,
        skipReason: d.skipReason,
        gate: d.gate,
        judge: stripPacket(d.judge),
        plan: d.plan,
      })),
      orders: orders.map((o) => {
        const t = o.trackerId ? tById.get(o.trackerId) : undefined;
        return {
          id: o.id,
          decisionId: o.decisionId,
          tradingsymbol: o.tradingsymbol,
          side: o.side,
          qty: o.qty,
          limitPrice: o.limitPrice,
          sl: o.sl,
          targets: o.targets,
          status: o.status,
          statusReason: o.statusReason,
          fillPrice: o.fillPrice,
          filledAt: o.filledAt,
          trackerStatus: t?.status ?? null,
          lastLtp: t?.lastLtp ?? null,
          pnl: t?.pnl ?? null,
          createdAt: o.createdAt,
        };
      }),
      channels: Object.entries(byChannel ?? {}).map(([id, stats]) => ({ id, title: titles.get(id) ?? id, stats })),
    };
  }
}

/** The judge's packet is large; the page needs the verdict, not the evidence. */
function stripPacket(j: unknown): unknown {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return j;
  const { packet: _packet, ...rest } = j as Record<string, unknown>;
  return rest;
}
