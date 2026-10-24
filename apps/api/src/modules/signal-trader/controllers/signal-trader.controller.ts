import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Post } from '@nestjs/common';
import { AdminOnly, CurrentUser, type AuthenticatedUser } from '../../../common/decorators';
import { SignalTraderRepository } from '../repositories/signal-trader.repository';
import { SignalTraderService } from '../services/signal-trader.service';
import { istDayStart, slEnforceability } from '../domain/execution';
import { decisionIdFromTags } from '../domain/paper';
import { paperSummary, liveSummary } from '../domain/paper-summary';
import { readTrigger } from '../domain/trigger';

/** How far back the Paper (no funds) section looks (analysis needs more than today). */
const PAPER_LOOKBACK_DAYS = 30;

/** Owner only: ADMIN role AND, when HUB_OWNER_USER_ID is set, that exact user. */
export function ownerAllowed(user: Pick<AuthenticatedUser, 'userId' | 'role'> | undefined, ownerUserId: string | null): boolean {
  if (!user?.userId || user.role !== 'ADMIN') return false;
  return ownerUserId ? user.userId === ownerUserId : true;
}

/**
 * /api/signal-trader — the "Telegram signals" page. Nothing here places or cancels anything; the
 * mode and caps come from env only. The one write is the owner's paperOnNoFunds toggle (persisted on
 * the app settings row, user_settings.signalPaperOnNoFunds).
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
    const paper = await this.paperSection(now, titles);
    return {
      mode: cfg.mode,
      paperOnNoFunds: { enabled: await this.repo.paperOnNoFunds(), store: 'user_settings.signalPaperOnNoFunds' },
      paper,
      caps: {
        maxLots: cfg.maxLots,
        maxLossPerTrade: cfg.maxLossPerTrade,
        maxTradesPerDay: cfg.maxTradesPerDay,
        dailyLossStop: cfg.dailyLossStop,
        entryTolerancePct: cfg.entryTolerancePct,
        product: cfg.product,
        triggerWaitMin: cfg.triggerWaitMin,
        triggerMaxPending: cfg.triggerMaxPending,
        engineSl: cfg.engineSl,
      },
      // Armed BUY ABOVE / SELL BELOW triggers (decision PENDING) with their countdown data.
      pending: decisions
        .filter((d) => d.decision === 'PENDING' && d.status === 'PENDING')
        .map((d) => {
          const t = readTrigger(d.plan);
          const plan = (d.plan ?? {}) as Record<string, unknown>;
          return {
            id: d.id,
            channel: d.channelId ? (titles.get(d.channelId) ?? d.channelId) : null,
            underlying: d.underlying,
            tradingsymbol: typeof plan.tradingsymbol === 'string' ? plan.tradingsymbol : null,
            side: typeof plan.side === 'string' ? plan.side : null,
            sl: typeof plan.sl === 'number' ? plan.sl : null,
            slSource: typeof plan.slSource === 'string' ? plan.slSource : null,
            engineSl: (plan.engineSl ?? null) as { method: string; detail: string } | null,
            trigger: t,
          };
        }),
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

  /** Owner toggle: a TAKE the account cannot fund becomes a PAPER trade (on) or a plain SKIP (off). */
  @AdminOnly()
  @Post('settings/paper-on-no-funds')
  async setPaperOnNoFunds(@Body() body: { enabled?: unknown }, @CurrentUser() user?: AuthenticatedUser) {
    if (!ownerAllowed(user, this.trader.config.ownerUserId)) throw new ForbiddenException('owner only');
    if (typeof body?.enabled !== 'boolean') throw new BadRequestException('enabled must be true or false');
    if (!(await this.repo.setPaperOnNoFunds(body.enabled))) throw new ConflictException('the app settings row does not exist yet — open Settings once');
    return { enabled: await this.repo.paperOnNoFunds() };
  }

  /** PAPER (no funds) decisions of the last 30 days with their paper trades' outcomes. */
  private async paperSection(now: Date, titles: Map<string, string>) {
    const since = new Date(istDayStart(now).getTime() - (PAPER_LOOKBACK_DAYS - 1) * 86_400_000);
    const decisions = await this.repo.paperDecisionsSince(since);
    const trades = await this.repo.paperTradesFor(decisions.map((d) => d.id));
    const byDecision = new Map(trades.map((t) => [decisionIdFromTags(t.entryTags), t]));
    const missing = decisions.map((d) => d.channelId).filter((x): x is string => !!x && !titles.has(x));
    if (missing.length) for (const c of await this.repo.channelTitles([...new Set(missing)])) titles.set(c.id, c.title);
    const rows = decisions.map((d) => {
      const t = byDecision.get(d.id) ?? null;
      const plan = (d.plan ?? null) as Record<string, unknown> | null;
      const fundsCheck = Array.isArray(d.gate) ? (d.gate as Array<Record<string, unknown>>).find((c) => c.name === 'funds' || c.name === 'broker_funds_reject') : undefined;
      return {
        decisionId: d.id,
        decidedAt: d.decidedAt,
        channel: d.channelId ? (titles.get(d.channelId) ?? d.channelId) : null,
        underlying: d.underlying,
        plan: plan ? { tradingsymbol: plan.tradingsymbol, side: plan.side, qty: plan.qty, limitPrice: plan.limitPrice, sl: plan.sl, targets: plan.targets } : null,
        funds: (fundsCheck?.funds ?? null) as { available: number | null; required: number; ok: boolean | null; method: string } | null,
        trigger: (plan?.paper as { trigger?: string } | undefined)?.trigger ?? null,
        paperError: (plan?.paper as { status?: string; reason?: string } | undefined)?.status === 'FAILED' ? ((plan?.paper as { reason?: string }).reason ?? 'failed') : null,
        trade: t
          ? { id: t.id, status: t.status, entryPrice: t.entryPrice, exitPrice: t.exitPrice, pnl: t.pnl, exitReasonTag: t.exitReasonTag, exitTime: t.exitTime }
          : null,
      };
    });
    // The live signal trades over the same window, for the side-by-side comparison.
    const liveOrders = await this.repo.ordersSince(since);
    const liveTrackers = new Map((await this.repo.trackersByIds(liveOrders.map((o) => o.trackerId).filter((x): x is string => !!x))).map((t) => [t.id, t]));
    const live = liveSummary(
      liveOrders.map((o) => {
        const t = o.trackerId ? liveTrackers.get(o.trackerId) : undefined;
        return { status: o.status, trackerStatus: t?.status ?? null, pnl: t?.pnl ?? null };
      }),
    );
    return { lookbackDays: PAPER_LOOKBACK_DAYS, rows, summary: paperSummary(rows.map((r) => r.trade)), live };
  }
}

/** The judge's packet is large; the page needs the verdict, not the evidence. */
function stripPacket(j: unknown): unknown {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return j;
  const { packet: _packet, ...rest } = j as Record<string, unknown>;
  return rest;
}
