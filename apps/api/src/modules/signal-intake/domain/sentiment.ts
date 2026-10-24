import { asInfoItems, type InfoItem } from './info';

/**
 * "Channel sentiment" per underlying over a window (24 h by default): BULL / BEAR item counts, weighted
 * by each channel's CHANNEL_INFO accuracy (self-review byChannel) when it has enough judged items.
 * Read-only context for the signal judge and the Night Report — never a trade trigger.
 */

export interface InfoRowLite {
  messageId?: string;
  channelId: string;
  channelTitle?: string | null;
  postedAt: Date;
  items: unknown;
}

/** The self-review byChannel entry fields this reads (ChannelStats, info part). */
export interface ChannelInfoAccuracy {
  infoRolling20?: number | null;
  infoRolling20Right?: number;
  infoRolling20Wrong?: number;
}

export interface UnderlyingSentiment {
  underlying: string;
  items: number;
  bull: number;
  bear: number;
  neutral: number;
  weightedBull: number;
  weightedBear: number;
  /** (wBull − wBear) / (wBull + wBear) in [−1, 1]; null when no directional item. */
  net: number | null;
  lean: 'BULL' | 'BEAR' | 'MIXED' | 'NONE';
  channels: number;
  latestAt: string;
}

/** A channel's weight is its rolling INFO hit rate once it has this many judged items; else neutral. */
export const SENTIMENT_MIN_JUDGED = 5;
export const SENTIMENT_DEFAULT_WEIGHT = 0.5;
const LEAN_AT = 0.25;

export function channelWeight(acc: ChannelInfoAccuracy | null | undefined): number {
  if (!acc) return SENTIMENT_DEFAULT_WEIGHT;
  const judged = (acc.infoRolling20Right ?? 0) + (acc.infoRolling20Wrong ?? 0);
  const rate = acc.infoRolling20;
  return judged >= SENTIMENT_MIN_JUDGED && typeof rate === 'number' && Number.isFinite(rate) ? rate : SENTIMENT_DEFAULT_WEIGHT;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function channelSentiment(rows: readonly InfoRowLite[], accuracy: Readonly<Record<string, ChannelInfoAccuracy | undefined>> | null): UnderlyingSentiment[] {
  const by = new Map<string, { bull: number; bear: number; neutral: number; wb: number; ws: number; items: number; ch: Set<string>; latest: number }>();
  for (const r of rows) {
    const w = channelWeight(accuracy?.[r.channelId]);
    for (const it of asInfoItems(r.items)) {
      const s = by.get(it.underlying) ?? { bull: 0, bear: 0, neutral: 0, wb: 0, ws: 0, items: 0, ch: new Set<string>(), latest: 0 };
      s.items++;
      s.ch.add(r.channelId);
      s.latest = Math.max(s.latest, r.postedAt.getTime());
      if (it.bias === 'BULL') {
        s.bull++;
        s.wb += w;
      } else if (it.bias === 'BEAR') {
        s.bear++;
        s.ws += w;
      } else if (it.bias === 'NEUTRAL') s.neutral++;
      by.set(it.underlying, s);
    }
  }
  const out: UnderlyingSentiment[] = [];
  for (const [underlying, s] of by) {
    const tot = s.wb + s.ws;
    const net = tot > 0 ? r3((s.wb - s.ws) / tot) : null;
    out.push({
      underlying,
      items: s.items,
      bull: s.bull,
      bear: s.bear,
      neutral: s.neutral,
      weightedBull: r3(s.wb),
      weightedBear: r3(s.ws),
      net,
      lean: net === null ? 'NONE' : net >= LEAN_AT ? 'BULL' : net <= -LEAN_AT ? 'BEAR' : 'MIXED',
      channels: s.ch.size,
      latestAt: new Date(s.latest).toISOString(),
    });
  }
  return out.sort((a, b) => b.items - a.items || a.underlying.localeCompare(b.underlying));
}

/** One line per item for a report (channel, underlying, bias, levels, condition). */
export interface InfoListItem {
  channelId: string;
  channel: string;
  postedAt: string;
  underlying: string;
  bias: InfoItem['bias'];
  levels: number[];
  targetLevel: number | null;
  oi: InfoItem['oi'];
  condition: InfoItem['condition'];
  horizon: InfoItem['horizon'];
}

export function infoList(rows: readonly InfoRowLite[], cap = 60): InfoListItem[] {
  const out: InfoListItem[] = [];
  for (const r of [...rows].sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime())) {
    for (const it of asInfoItems(r.items)) {
      out.push({
        channelId: r.channelId,
        channel: r.channelTitle ?? r.channelId,
        postedAt: r.postedAt.toISOString(),
        underlying: it.underlying,
        bias: it.bias,
        levels: it.levels,
        targetLevel: it.targetLevel,
        oi: it.oi,
        condition: it.condition,
        horizon: it.horizon,
      });
      if (out.length >= cap) return out;
    }
  }
  return out;
}
