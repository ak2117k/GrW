import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { CallRow, IdeaRow, SetupRow, WatchRow } from '../domain/signal-board';

/**
 * Raw reads for the signal board, one per source. Read-only. `from`/`to` bound the trading day
 * (the night run before it included); setups are matched by their session_date instead.
 */
@Injectable()
export class SignalBoardRepository {
  constructor(private readonly prisma: PrismaService) {}

  setups(userId: string, session: string): Promise<SetupRow[]> {
    return this.prisma.$queryRaw<SetupRow[]>`
      SELECT t.id, t.created_at, t.symbol, t.instrument, t.side, t.entry_rule, t.entry_ref, t.stop, t.target1, t.target2,
             t.outcome_status, t.outcome_r, n.rationale AS idea_rationale,
             d.decision, d.skip_reason, d.plan, d.ai_check
      FROM trade_setups t
      LEFT JOIN news_ideas n ON n.id = t.news_idea_id
      LEFT JOIN trade_signals s ON s.message_id = 'setup:' || t.id
      LEFT JOIN LATERAL (
        SELECT decision, skip_reason, plan, ai_check FROM signal_decisions
        WHERE signal_id = s.id ORDER BY evaluation DESC LIMIT 1
      ) d ON true
      WHERE t.user_id = ${userId} AND t.session_date = ${session}
      ORDER BY t.created_at DESC`;
  }

  /** News ideas of the window, plus which of them already became a setup. */
  async ideas(from: Date, to: Date): Promise<{ rows: IdeaRow[]; withSetup: Set<string> }> {
    const rows = await this.prisma.$queryRaw<IdeaRow[]>`
      SELECT id, created_at, symbol, idea, rationale, what_to_do, move_bp
      FROM news_ideas WHERE created_at >= ${from} AND created_at < ${to}
      ORDER BY created_at DESC LIMIT 200`;
    if (!rows.length) return { rows, withSetup: new Set() };
    const linked = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT news_idea_id AS id FROM trade_setups WHERE news_idea_id IN (${Prisma.join(rows.map((r) => r.id))})`;
    return { rows, withSetup: new Set(linked.map((r) => r.id)) };
  }

  /** Each Telegram call of the window with its latest decision (calls not yet decided included). */
  calls(userId: string, from: Date, to: Date): Promise<CallRow[]> {
    return this.prisma.$queryRaw<CallRow[]>`
      SELECT s.id AS signal_id, s.created_at, ch.title AS channel, s.underlying, s.tradingsymbol, s.side, s.entry_type,
             s.entry_low, s.entry_high, s.sl, s.targets, s.raw_text, s.outcome_status,
             d.decision, d.skip_reason, d.plan, d.judge, d.ai_check
      FROM trade_signals s
      LEFT JOIN telegram_channels ch ON ch.id = s.channel_id
      LEFT JOIN LATERAL (
        SELECT decision, skip_reason, plan, judge, ai_check FROM signal_decisions
        WHERE signal_id = s.id AND (user_id = ${userId} OR user_id IS NULL)
        ORDER BY evaluation DESC LIMIT 1
      ) d ON true
      WHERE s.created_at >= ${from} AND s.created_at < ${to} AND s.parser <> 'setup'
      ORDER BY s.created_at DESC LIMIT 300`;
  }

  /** Breakout watches still waiting, or that lapsed in the window (a fired one is shown as its call). */
  watches(from: Date, to: Date): Promise<WatchRow[]> {
    return this.prisma.$queryRaw<WatchRow[]>`
      SELECT w.id, w.created_at, ch.title AS channel, w.underlying, w.side, w.level, w.status, w.last_ltp, w.reason
      FROM signal_watches w
      LEFT JOIN telegram_channels ch ON ch.id = w.channel_id
      WHERE (w.status = 'ACTIVE' AND w.expires_at >= ${from}) OR (w.status = 'EXPIRED' AND w.updated_at >= ${from} AND w.updated_at < ${to})
      ORDER BY w.created_at DESC LIMIT 200`;
  }
}
