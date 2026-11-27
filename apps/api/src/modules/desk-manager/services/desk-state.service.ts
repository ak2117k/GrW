import { Inject, Injectable, Optional } from '@nestjs/common';
import { isHeld } from '../../sentinel-executor/domain/guards';
import { parseAutoExitConfig } from '../../sentinel-executor/domain/auto-exit.config';
import { AUTHORITY_STATE, TRADE_BRIEFS, type AuthorityStatePort, type TradeBriefsPort } from '../../exit-authority/exit-authority.tokens';
import { minutesToClose } from '../../trade-sentinel/market-sessions';
import { isPaperTracker } from '../../trade-sentinel/paper/paper-tracker';
import type { DeskManagerConfig } from '../desk-manager.config';
import { authorityLive } from '../domain/authority';
import { BRIEF_MAX_CHARS } from '../domain/desk.types';

/** A brief in the packet is cut to this (up to 50 positions must fit PACKET_MAX_CHARS); the agent reads it whole. */
const PACKET_BRIEF_CHARS = Math.min(800, BRIEF_MAX_CHARS);
import type {
  Block,
  DayPnlPath,
  DeskPacket,
  GuardState,
  HealthView,
  InstrumentView,
  MemoryView,
  PositionView,
  Proposal,
  RecentExit,
} from '../domain/desk.types';
import {
  capProposals,
  countNotCheckable,
  cut,
  DESK_BLOCK_MS,
  failedBlocks,
  istClock,
  managerLevelsFrom,
  nearestLevels,
  PACKET_MAX_CHARS,
  pickUnderlyings,
  PROPOSAL_WINDOW_MS,
  RECENT_EXIT_WINDOW_MS,
  resultText,
  timedBlock,
  timedValue,
} from '../domain/packet-blocks';
import { DeskStateRepository } from '../repositories/desk-state.repository';

/**
 * The guard read the packet needs (Task 1's DeskGuardService.state). Task 8 binds it with
 * `{ provide: DESK_STATE_GUARD, useExisting: DeskGuardService }`. Absent = the pnl / guard blocks say so.
 */
export interface DeskGuardReader {
  state(userId: string, now: Date, underlying?: string | null): Promise<GuardState>;
}
export const DESK_STATE_GUARD = Symbol('DESK_STATE_GUARD');

/**
 * Market reads per underlying (hub LTP, level book, 15m trend, chain walls). Cached/in-memory sources only —
 * no broker call per run. Task 8 binds the adapter; absent = every instrument lists what is missing.
 */
export interface DeskMarketPort {
  ltp(underlying: string, now: Date): Promise<number | null>;
  day(underlying: string, now: Date): Promise<{ open: number | null; high: number | null; low: number | null; vwap: number | null } | null>;
  trend15m(underlying: string, now: Date): Promise<string | null>;
  levels(underlying: string, now: Date): Promise<number[]>;
  chainWalls(underlying: string, now: Date): Promise<{ call: number | null; put: number | null } | null>;
  /** The underlying's price at a past instant (15m bar close); optional. */
  priceAt?(underlying: string, at: Date): Promise<number | null>;
}
export const DESK_MARKET = Symbol('DESK_MARKET');

/** Feed status and agent heartbeats for the health block. Absent = 'unknown'. */
export interface DeskStatusPort {
  feed(): Promise<string>;
  agents(): Promise<Record<string, string>>;
}
export const DESK_STATUS = Symbol('DESK_STATUS');

const SRC = {
  day: 'clock',
  pnl: 'desk-guard.path',
  guard: 'desk-guard.state',
  positions: 'trade_trackers+trades(desk-manager)+sentinel_verdicts/paper_sentinel_looks+AI_AUTO_EXIT_HOLD',
  recentExits: 'trade_trackers(closed 90m)+sentinel_verdicts',
  proposals: 'message_readings+ai_setups+signal_decisions+entry_engine_decisions (2h)',
  instruments: 'market-hub+level-book+oi_snapshots',
  health: 'message_readings.claims+feed+agents',
  memory: 'desk_manager_decisions+agent_lessons',
} as const;

/** Sub-reads inside the instruments block share the 3 s box; the block itself gets a small margin over it. */
const INSTRUMENTS_BLOCK_MS = DESK_BLOCK_MS + 500;

function minutesSince(from: Date, now: Date): number {
  return Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000));
}

/**
 * Builds what the manager sees (plan Task 3). Every block is time-boxed (3 s) and comes back present or
 * unavailable with its reason — one failing source never hides the others, and nothing is silently missing.
 */
@Injectable()
export class DeskStateService {
  constructor(
    private readonly repo: DeskStateRepository,
    @Optional() @Inject(DESK_STATE_GUARD) private readonly guard?: DeskGuardReader,
    @Optional() @Inject(DESK_MARKET) private readonly market?: DeskMarketPort,
    @Optional() @Inject(DESK_STATUS) private readonly status?: DeskStatusPort,
    // Trade agent exit authority: live adds each live position's brief / hasBrief. Absent ⇒ off (packet unchanged).
    @Optional() @Inject(TRADE_BRIEFS) private readonly briefs?: TradeBriefsPort | null,
    @Optional() @Inject(AUTHORITY_STATE) private readonly authority?: AuthorityStatePort | null,
  ) {}

  async build(userId: string, now: Date, cfg: DeskManagerConfig): Promise<DeskPacket> {
    const hold = parseAutoExitConfig(process.env).hold ?? [];
    const liveFromIst = String(process.env.SIGNAL_LIVE_FROM_IST ?? '').trim() || '09:45';

    // One guard read feeds both the pnl and guard blocks.
    const guardRead = this.guard ? this.guard.state(userId, now) : Promise.reject(new Error('desk guard not wired'));
    guardRead.catch(() => undefined);

    const [day, guard, positions, recentExits, proposals, memory] = await Promise.all([
      timedBlock(SRC.day, async () => ({ ist: istClock(now), nseMinToClose: minutesToClose('NSE', now), mcxMinToClose: minutesToClose('MCX', now), liveFromIst })),
      timedBlock<GuardState>(SRC.guard, () => guardRead),
      timedBlock<PositionView[]>(SRC.positions, () => this.positions(userId, now, hold)),
      timedBlock<RecentExit[]>(SRC.recentExits, () => this.recentExits(userId, now)),
      timedBlock<Proposal[]>(SRC.proposals, async () => capProposals(await this.repo.proposalsSince(userId, new Date(now.getTime() - PROPOSAL_WINDOW_MS)))),
      timedBlock<MemoryView>(SRC.memory, () => this.memory(userId, now)),
    ]);
    const pnl: Block<DayPnlPath> =
      guard.status === 'present' && guard.value
        ? { status: 'present', value: guard.value.path, source: SRC.pnl }
        : { status: 'unavailable', reason: guard.reason ?? 'guard unavailable', source: SRC.pnl };

    // Slots by what the manager can act on: open positions (exits), proposals (entries), then recent exits.
    const underlyings = pickUnderlyings([
      (positions.value ?? []).map((p) => p.underlying),
      (proposals.value ?? []).map((p) => p.underlying),
      (recentExits.value ?? []).map((e) => e.underlying),
    ]);
    const instruments = await timedBlock<Record<string, InstrumentView>>(SRC.instruments, () => this.instruments(underlyings, now), INSTRUMENTS_BLOCK_MS);
    if (recentExits.status === 'present' && instruments.status === 'present') {
      for (const e of recentExits.value ?? []) if (e.underlying && e.underlyingNow == null) e.underlyingNow = instruments.value?.[e.underlying]?.ltp ?? null;
    }

    const failed = failedBlocks({ day, pnl, guard, positions, recentExits, proposals, instruments, memory });
    const health = await timedBlock<HealthView>(SRC.health, () => this.health(now, failed));

    const packet: DeskPacket = { at: now.toISOString(), mode: cfg.mode, day, pnl, guard, positions, recentExits, proposals, instruments, health, memory };
    return fitPacket(packet);
  }

  /** Task 4's cadence: busy while a position is open or a proposal is < 30 min old. */
  busy(userId: string, now: Date): Promise<boolean> {
    return this.repo.busy(userId, now);
  }

  private async positions(userId: string, now: Date, hold: string[]): Promise<PositionView[]> {
    const rows = await this.repo.openPositions(userId);
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.trackerId);
    const openIds = rows.map((r) => r.openDecisionId).filter((x): x is string => !!x);
    const [sentinel, levelRows, briefs] = await Promise.all([this.repo.latestSentinel(ids), this.repo.managerLevelRows(ids, openIds), this.briefsOf(ids)]);
    return rows.map((r) => {
      const s = sentinel.get(r.trackerId);
      const mine = levelRows.filter((d) => d.trackerId === r.trackerId || (r.openDecisionId != null && d.id === r.openDecisionId));
      const lv = managerLevelsFrom(mine);
      return {
        trackerId: r.trackerId,
        symbol: r.symbol,
        exchange: r.exchange,
        underlying: r.underlying,
        qty: r.qty,
        entry: r.entry,
        ltp: r.ltp,
        pnl: r.pnl,
        ageMin: minutesSince(r.entryAt, now),
        origin: r.origin,
        held: isHeld(hold, { id: r.trackerId, symbol: r.symbol }),
        sentinel: s ? { verdict: s.verdict, thesisStatus: s.thesisStatus, reason: s.reason, invalidation: s.invalidation, at: s.at.toISOString() } : null,
        managerStop: lv.stop,
        managerTargets: lv.targets,
        ...(briefs?.has(r.trackerId) ? { brief: briefs.get(r.trackerId) ?? null, hasBrief: briefs.get(r.trackerId) != null } : {}),
      };
    });
  }

  /**
   * Authority live only: tracker → its brief (null = none) for the LIVE trackers. null when off / not wired, so
   * the positions carry no brief fields. A failed read is "no brief" (the manager is asked for one; harmless).
   */
  private async briefsOf(ids: string[]): Promise<Map<string, string | null> | null> {
    const port = this.briefs;
    if (!port || !authorityLive(this.authority)) return null;
    const live = ids.filter((id) => !isPaperTracker(id));
    const out = new Map<string, string | null>();
    await Promise.all(
      live.map(async (id) => {
        const text = await port.briefFor(id).catch(() => null);
        out.set(id, typeof text === 'string' && text.trim() ? cut(text, PACKET_BRIEF_CHARS) : null);
      }),
    );
    return out;
  }

  private async recentExits(userId: string, now: Date): Promise<RecentExit[]> {
    const since = new Date(now.getTime() - RECENT_EXIT_WINDOW_MS);
    const rows = (await this.repo.closedSince(userId, since)).filter((r) => r.exitAt.getTime() >= since.getTime() && r.exitAt.getTime() <= now.getTime());
    if (rows.length === 0) return [];
    const before = new Map(rows.map((r) => [r.trackerId, r.exitAt] as const));
    const sentinel = await this.repo.latestSentinel(rows.map((r) => r.trackerId), before);
    const priceAt = this.market?.priceAt?.bind(this.market);
    return Promise.all(
      rows
        .sort((a, b) => b.exitAt.getTime() - a.exitAt.getTime())
        .map(async (r) => {
          const s = sentinel.get(r.trackerId);
          let underlyingAtExit: number | null = null;
          if (priceAt && r.underlying) {
            const v = await timedValue(() => priceAt(r.underlying as string, r.exitAt));
            underlyingAtExit = v.ok ? v.value : null;
          }
          return {
            trackerId: r.trackerId,
            symbol: r.symbol,
            underlying: r.underlying,
            exitAt: r.exitAt.toISOString(),
            pnl: r.pnl,
            lastSentinel: s ? { verdict: s.verdict, thesisStatus: s.thesisStatus, reason: s.reason } : null,
            underlyingAtExit,
            underlyingNow: null,
          };
        }),
    );
  }

  private async instruments(underlyings: string[], now: Date): Promise<Record<string, InstrumentView>> {
    const out: Record<string, InstrumentView> = {};
    const m = this.market;
    await Promise.all(
      underlyings.map(async (u) => {
        const view: InstrumentView = { underlying: u, ltp: null, dayOpen: null, dayHigh: null, dayLow: null, vwap: null, trend15m: null, levels: [], chainWalls: null, missing: [] };
        out[u] = view;
        if (!m) {
          view.missing.push('market port not wired: ltp, day, vwap, trend15m, levels, chainWalls');
          return;
        }
        const [ltp, day, trend, levels, walls] = await Promise.all([
          timedValue(() => m.ltp(u, now)),
          timedValue(() => m.day(u, now)),
          timedValue(() => m.trend15m(u, now)),
          timedValue(() => m.levels(u, now)),
          timedValue(() => m.chainWalls(u, now)),
        ]);
        const miss = (name: string, r: { ok: boolean; reason?: string }) => view.missing.push(r.ok ? `${name}: none` : `${name}: ${r.reason}`);
        if (ltp.ok && ltp.value != null) view.ltp = ltp.value;
        else miss('ltp', ltp);
        if (day.ok && day.value) {
          view.dayOpen = day.value.open;
          view.dayHigh = day.value.high;
          view.dayLow = day.value.low;
          view.vwap = day.value.vwap;
          if (day.value.vwap == null) view.missing.push('vwap: none');
        } else miss('day', day);
        if (trend.ok && trend.value) view.trend15m = trend.value;
        else miss('trend15m', trend);
        if (levels.ok && levels.value.length > 0) view.levels = nearestLevels(levels.value, view.ltp);
        else miss('levels', levels);
        if (walls.ok && walls.value) view.chainWalls = walls.value;
        else miss('chainWalls', walls);
      }),
    );
    return out;
  }

  private async health(now: Date, failed: string[]): Promise<HealthView> {
    const [claims, feed, agents] = await Promise.all([
      this.repo.claimsOfDay(now).then(
        (c) => ({ ok: true as const, c }),
        (err: unknown) => ({ ok: false as const, err }),
      ),
      this.status ? timedValue(() => (this.status as DeskStatusPort).feed()) : Promise.resolve({ ok: true as const, value: 'unknown (status port not wired)' }),
      this.status ? timedValue(() => (this.status as DeskStatusPort).agents()) : Promise.resolve({ ok: true as const, value: {} as Record<string, string> }),
    ]);
    const blocks = [...failed];
    let counted = { total: 0, byReason: {} as Record<string, number> };
    if (claims.ok) counted = countNotCheckable(claims.c);
    else blocks.push(`health.notCheckable: ${cut(claims.err instanceof Error ? claims.err.message : String(claims.err), 200)}`);
    return {
      notCheckableToday: counted.total,
      notCheckableReasons: counted.byReason,
      feed: feed.ok ? String(feed.value) : `unknown (${feed.reason})`,
      agents: agents.ok ? agents.value : {},
      failedBlocks: blocks,
    };
  }

  /** The memory block (also the supreme confirm's: SupremeConfirmService). */
  async memory(userId: string, now: Date): Promise<MemoryView> {
    const [today, scorecard, lessons] = await Promise.all([this.repo.decisionsToday(userId, now), this.repo.scorecard(userId, 5, now), this.repo.deskLessons()]);
    return {
      today: today.map((d) => ({ at: d.createdAt.toISOString(), action: d.action, underlying: d.underlying, status: d.status, result: resultText(d.result) })),
      scorecard,
      lessons,
    };
  }
}

/**
 * Keeps the packet JSON under PACKET_MAX_CHARS: first proposal `detail`s are dropped from the oldest up, then
 * the oldest proposals themselves. Dropped proposals are stated in the proposals block's `source`.
 */
export function fitPacket(packet: DeskPacket): DeskPacket {
  const size = () => JSON.stringify(packet).length;
  if (size() <= PACKET_MAX_CHARS) return packet;
  const list = packet.proposals.value;
  if (packet.proposals.status === 'present' && list) {
    for (let i = list.length - 1; i >= 0 && size() > PACKET_MAX_CHARS; i--) list[i] = { ...list[i], detail: { trimmed: true } };
    let dropped = 0;
    while (list.length > 0 && size() > PACKET_MAX_CHARS) {
      list.pop();
      dropped += 1;
    }
    if (dropped > 0) packet.proposals.source = `${packet.proposals.source} (oldest ${dropped} dropped to fit the packet)`;
  }
  return packet;
}
