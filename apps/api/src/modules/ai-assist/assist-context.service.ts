import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

export interface AssistPositionLine {
  symbol: string;
  exchange: string;
  kind: string;
  qty: number;
  entryPrice: number;
  lastLtp: number | null;
  pnl: number | null;
  pnlPercent: number | null;
}

export interface AssistVerdictLine {
  symbol: string;
  verdict: string;
  confidence: string;
  thesisStatus: string;
  reason: string;
  at: Date;
}

export interface AssistContext {
  positions: AssistPositionLine[];
  verdictsToday: AssistVerdictLine[];
}

const MAX_POSITIONS = 40;
const MAX_VERDICTS = 20;
const REASON_CHARS = 280;

/** Midnight IST of the day containing `now`. */
function istMidnight(now: Date): Date {
  const ymd = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  return new Date(`${ymd}T00:00:00+05:30`);
}

/**
 * READ-ONLY context for the user-facing Claude calls: the owner's open
 * positions (trade trackers) and today's latest sentinel verdict per position.
 * Two `findMany` reads; nothing here writes, places or changes anything.
 */
@Injectable()
export class AssistContextService {
  constructor(private readonly prisma: PrismaService) {}

  async forUser(userId: string, now: Date = new Date()): Promise<AssistContext> {
    const [positions, verdicts] = await Promise.all([
      this.prisma.tradeTracker.findMany({
        where: { userId, status: 'OPEN' },
        orderBy: { entryTime: 'asc' },
        take: MAX_POSITIONS,
        select: {
          symbol: true, exchange: true, kind: true, qty: true, entryPrice: true,
          lastLtp: true, pnl: true, pnlPercent: true,
        },
      }),
      this.prisma.sentinelVerdict.findMany({
        where: { userId, createdAt: { gte: istMidnight(now) } },
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: { trackerId: true, symbol: true, verdict: true, confidence: true, thesisStatus: true, reason: true, createdAt: true },
      }),
    ]);
    const seen = new Set<string>();
    const verdictsToday: AssistVerdictLine[] = [];
    for (const v of verdicts) {
      if (seen.has(v.trackerId)) continue; // newest first: keep the latest per position
      seen.add(v.trackerId);
      verdictsToday.push({
        symbol: v.symbol,
        verdict: v.verdict,
        confidence: v.confidence,
        thesisStatus: v.thesisStatus,
        reason: v.reason.length > REASON_CHARS ? `${v.reason.slice(0, REASON_CHARS)}…` : v.reason,
        at: v.createdAt,
      });
      if (verdictsToday.length >= MAX_VERDICTS) break;
    }
    return { positions, verdictsToday };
  }
}

const num = (v: number | null | undefined, d = 2) =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : 'n/a';

/** Compact plain-text rendering for the prompt's data block. */
export function renderAssistContext(ctx: AssistContext): string {
  const lines: string[] = [];
  lines.push(`Open positions (${ctx.positions.length}):`);
  if (ctx.positions.length === 0) lines.push('- none');
  for (const p of ctx.positions) {
    lines.push(
      `- ${p.symbol} (${p.exchange}, ${p.kind}) qty ${p.qty} @ ${num(p.entryPrice)}; ` +
        `ltp ${num(p.lastLtp)}; P&L ${num(p.pnl)} (${num(p.pnlPercent)}%)`,
    );
  }
  lines.push('');
  lines.push(`Today's latest sentinel verdict per position (${ctx.verdictsToday.length}):`);
  if (ctx.verdictsToday.length === 0) lines.push('- none today');
  for (const v of ctx.verdictsToday) {
    const ist = new Date(v.at.getTime() + 330 * 60_000).toISOString().slice(11, 16);
    lines.push(`- ${v.symbol}: ${v.verdict} (${v.confidence}, thesis ${v.thesisStatus}) at ${ist} IST — ${v.reason}`);
  }
  return lines.join('\n');
}
