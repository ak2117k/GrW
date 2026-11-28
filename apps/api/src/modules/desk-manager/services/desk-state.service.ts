import { Inject, Injectable, Optional } from '@nestjs/common';
import { contractValueFactor } from '@td/shared';
import { engineContract } from '../../entry-engine/domain/engine-contract';
import type { ResolvedContract } from '../../signal-trader/domain/contract-resolver';
import { requiredFunds } from '../../signal-trader/domain/funds';
import { parseSignalTraderConfig, type SignalTraderConfig } from '../../signal-trader/domain/signal-trader.config';
import { SIGNAL_FUNDS, SIGNAL_TRADER_CONFIG, type FundsLike } from '../../signal-trader/services/signal-trader.service';
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
  ChannelView,
  DayPnlPath,
  DeskPacket,
  FundsView,
  GuardState,
  HealthView,
  InstrumentView,
  LotCost,
  MemoryView,
  PositionView,
  Proposal,
  RecentExit,
  UnderlyingLotCosts,
} from '../domain/desk.types';
import {
  CHANNEL_VIEW_WINDOW_MS,
  countNotCheckable,
  cut,
  DESK_BLOCK_MS,
  DESK_SLOW_BLOCK_MS,
  failedBlocks,
  istClock,
  lotCost,
  managerLevelsFrom,
  miniUnderlyingOf,
  nearestLevels,
  normaliseUnderlyingKey,
  PACKET_MAX_CHARS,
  pickUnderlyings,
  PROPOSAL_WINDOW_MS,
  quotaProposals,
  RECENT_EXIT_WINDOW_MS,
  resultText,
  timedBlock,
  timedValue,
} from '../domain/packet-blocks';
import { pickContractSpec } from '../domain/premium-risk';
import { DeskStateRepository } from '../repositories/desk-state.repository';
import { DESK_MARKET as DESK_LOT_MARKET, type DeskMarket, type DeskRef } from './desk-actions.ports';

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
  channelViews: 'message_readings(kind INFO, 3h)+telegram_channels',
  funds: 'broker RMS net (signal-trader funds read)+instrument master+ATM premiums',
} as const;

/**
 * The instruments and recentExits blocks: their sub-reads get the slow box (6 s; audit 2026-11-27: recentExits
 * timed out at 3 s in 30 runs), the block itself a small margin over it.
 */
const SLOW_BLOCK_MS = DESK_SLOW_BLOCK_MS + 500;
const INSTRUMENTS_BLOCK_MS = SLOW_BLOCK_MS;
/** Funds: the RMS read gets the 3 s box, the lot pricing its own 4 s, the block both plus a margin. */
const LOT_PRICING_MS = 4_000;
const FUNDS_BLOCK_MS = DESK_BLOCK_MS + LOT_PRICING_MS + 500;
/** Underlyings priced at once (each does 1-3 quote reads): stays well under Angel's 10 req/s. */
const LOT_PRICING_CONCURRENCY = 3;

function minutesSince(from: Date, now: Date): number {
  return Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000));
}

const refKey = (r: { exchange: string; token: string }) => `${r.exchange.toUpperCase()}:${r.token}`;

/** A cash-equity line (NSE / BSE): a holding or delivery, not an F&O / MCX position. */
function isEquityLine(exchange: string | null | undefined): boolean {
  const e = String(exchange ?? '').trim().toUpperCase();
  return e === 'NSE' || e === 'BSE';
}

/** The instrument master's underlying names (cached per master array: it is the same in-memory list run to run). */
const NAMES_CACHE = new WeakMap<object, ReadonlySet<string>>();
function masterNames(master: readonly unknown[]): ReadonlySet<string> {
  const hit = NAMES_CACHE.get(master);
  if (hit) return hit;
  const out = new Set<string>();
  for (const r of master as Array<{ name?: unknown }>) {
    const n = r && typeof r.name === 'string' ? r.name.trim().toUpperCase() : '';
    if (n) out.add(n);
  }
  NAMES_CACHE.set(master, out);
  return out;
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
    // The funds block: the order path's own RMS read (signal-trader SIGNAL_FUNDS: usable `net` margin), and the
    // quotes / instrument master the manager's OPEN prices with (desk-actions DESK_MARKET). Absent = said so.
    @Optional() @Inject(SIGNAL_FUNDS) private readonly funds?: Pick<FundsLike, 'available'> | null,
    @Optional() @Inject(DESK_LOT_MARKET) private readonly lotMarket?: DeskMarket | null,
    // The order path's funds buffer (SIGNAL_FUNDS_BUFFER_PCT): `fits` asks what the order path will ask.
    @Optional() @Inject(SIGNAL_TRADER_CONFIG) private traderCfg?: Pick<SignalTraderConfig, 'fundsBufferPct' | 'futMarginPct'> | null,
  ) {}

  private fundsCfg(): { fundsBufferPct: number; futMarginPct: number } {
    const c = (this.traderCfg ??= parseSignalTraderConfig(process.env));
    return { fundsBufferPct: c.fundsBufferPct, futMarginPct: c.futMarginPct };
  }

  async build(userId: string, now: Date, cfg: DeskManagerConfig): Promise<DeskPacket> {
    const hold = parseAutoExitConfig(process.env).hold ?? [];
    const liveFromIst = String(process.env.SIGNAL_LIVE_FROM_IST ?? '').trim() || '09:45';

    // One guard read feeds both the pnl and guard blocks.
    const guardRead = this.guard ? this.guard.state(userId, now) : Promise.reject(new Error('desk guard not wired'));
    guardRead.catch(() => undefined);
    // The funds read (the order path's RMS read) starts now; the lot costs need the instruments' prices.
    const fundsRead = this.funds ? this.funds.available(userId).catch(() => null) : Promise.reject(new Error('funds read not wired (SIGNAL_FUNDS)'));
    fundsRead.catch(() => undefined);

    const [day, guard, positions, recentExits, proposals, memory, channelViews, master] = await Promise.all([
      timedBlock(SRC.day, async () => ({ ist: istClock(now), nseMinToClose: minutesToClose('NSE', now), mcxMinToClose: minutesToClose('MCX', now), liveFromIst })),
      timedBlock<GuardState>(SRC.guard, () => guardRead),
      timedBlock<PositionView[]>(SRC.positions, () => this.positions(userId, now, hold)),
      timedBlock<RecentExit[]>(SRC.recentExits, () => this.recentExits(userId, now), SLOW_BLOCK_MS),
      timedBlock<Proposal[]>(SRC.proposals, () => this.repo.proposalsSince(userId, new Date(now.getTime() - PROPOSAL_WINDOW_MS))),
      timedBlock<MemoryView>(SRC.memory, () => this.memory(userId, now)),
      timedBlock<ChannelView[]>(SRC.channelViews, () => this.repo.channelViewsSince(new Date(now.getTime() - CHANNEL_VIEW_WINDOW_MS))),
      this.lotMarket ? timedValue(() => (this.lotMarket as DeskMarket).master()) : Promise.resolve({ ok: false as const, reason: 'lot market not wired' }),
    ]);
    const pnl: Block<DayPnlPath> =
      guard.status === 'present' && guard.value
        ? { status: 'present', value: guard.value.path, source: SRC.pnl }
        : { status: 'unavailable', reason: guard.reason ?? 'guard unavailable', source: SRC.pnl };

    // Slots by what the manager can act on: F&O / MCX positions (exits), proposals and channel views (entries),
    // recent exits, and only then equity / delivery lines (2026-11-27: 8 equity holdings took every slot and NIFTY,
    // with a live proposal, had no data in 79/154 runs). Keys normalised against the instrument master.
    const rows = master.ok && Array.isArray(master.value) ? master.value : null;
    const names = rows ? masterNames(rows) : null;
    // Quotas after the master: a bare UPDATE is kept when its summary names a listed instrument.
    if (proposals.status === 'present') proposals.value = quotaProposals(proposals.value ?? [], undefined, names);
    const pos = positions.value ?? [];
    const underlyings = pickUnderlyings(
      [
        pos.filter((p) => !isEquityLine(p.exchange)).map((p) => p.underlying),
        [...(proposals.value ?? []).map((p) => p.underlying), ...(channelViews.value ?? []).map((v) => v.subject)],
        (recentExits.value ?? []).map((e) => e.underlying),
        pos.filter((p) => isEquityLine(p.exchange)).map((p) => p.underlying),
      ],
      undefined,
      names,
    );
    const instruments = await timedBlock<Record<string, InstrumentView>>(SRC.instruments, () => this.instruments(underlyings, now), INSTRUMENTS_BLOCK_MS);
    if (recentExits.status === 'present' && instruments.status === 'present') {
      for (const e of recentExits.value ?? []) {
        const k = e.underlying ? normaliseUnderlyingKey(e.underlying, names) : null;
        if (k && e.underlyingNow == null) e.underlyingNow = instruments.value?.[k]?.ltp ?? null;
      }
    }
    const funds = await timedBlock<FundsView>(SRC.funds, () => this.fundsView(fundsRead, underlyings, instruments.value ?? {}, rows, now), FUNDS_BLOCK_MS);

    const failed = failedBlocks({ day, pnl, guard, positions, recentExits, proposals, instruments, memory, channelViews, funds });
    const health = await timedBlock<HealthView>(SRC.health, () => this.health(now, failed));

    const packet: DeskPacket = { at: now.toISOString(), mode: cfg.mode, day, pnl, guard, positions, recentExits, proposals, instruments, health, memory, funds, channelViews };
    return fitPacket(packet);
  }

  /**
   * The funds block: the owner's usable margin (the order path's RMS read — the "funds: INSUFFICIENT" check) and, for
   * each packet underlying, what 1 lot of the ATM CE / PE (nearest expiry) costs, plus the mini's where one exists.
   */
  private async fundsView(fundsRead: Promise<number | null>, underlyings: string[], instruments: Record<string, InstrumentView>, master: readonly unknown[] | null, now: Date): Promise<FundsView> {
    // Two boxes: a slow premium read must never blank `available` (RMS 3 s, lot pricing its own 4 s).
    if (!this.funds) await fundsRead; // throws: "funds read not wired" -> the block is unavailable
    const read = await timedValue(() => fundsRead, DESK_BLOCK_MS);
    const raw = read.ok ? read.value : null;
    const available = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw * 100) / 100 : null;
    const lots: Record<string, UnderlyingLotCosts> = {};
    for (const u of underlyings) lots[u] = { atmCe: null, atmPe: null, missing: [] };
    const m = this.lotMarket;
    if (!m || !master || master.length === 0) {
      for (const u of underlyings) lots[u].missing.push(m ? 'instrument master unavailable' : 'lot market not wired');
      return { available, lots };
    }
    const priced = await timedValue(() => this.priceLots(lots, underlyings, instruments, master, available, now), LOT_PRICING_MS);
    if (!priced.ok) for (const u of underlyings) if (!lots[u].atmCe && !lots[u].atmPe) lots[u].missing.push(`lot pricing: ${priced.reason}`);
    return { available, lots };
  }

  /** Fills `lots` in place; at most LOT_PRICING_CONCURRENCY underlyings priced at once (Angel REST 10 req/s). */
  private async priceLots(lots: Record<string, UnderlyingLotCosts>, underlyings: string[], instruments: Record<string, InstrumentView>, master: readonly unknown[], available: number | null, now: Date): Promise<void> {
    const m = this.lotMarket as DeskMarket;
    // One pass over the master: only the packet's names (and their minis) are searched per contract.
    const wanted = new Set(underlyings.flatMap((u) => [u, miniUnderlyingOf(u)].filter((x): x is string => !!x)));
    const rows = (master as Array<{ name?: unknown }>).filter((r) => r && wanted.has(String(r.name ?? '').trim().toUpperCase()));
    const queue = [...underlyings];
    const worker = async () => {
      for (let u = queue.shift(); u !== undefined; u = queue.shift()) await this.priceOne(lots[u], u, rows, instruments, available, now, m);
    };
    await Promise.all(Array.from({ length: Math.min(LOT_PRICING_CONCURRENCY, queue.length) }, worker));
  }

  /** One underlying: the spot (instruments ltp, else its line), the ATM CE / PE and the mini's. */
  private async priceOne(view: UnderlyingLotCosts, u: string, rows: readonly unknown[], instruments: Record<string, InstrumentView>, available: number | null, now: Date, m: DeskMarket): Promise<void> {
    let spot = instruments[u]?.ltp ?? null;
    if (spot == null) {
      const ref = await m.underlyingRef(u, now).catch(() => null);
      spot = ref ? ((await m.ltps([ref], now).catch(() => new Map<string, number>())).get(refKey(ref)) ?? null) : null;
    }
    if (spot == null || !(spot > 0)) {
      view.missing.push(`no price for ${u}: no ATM strike`);
      return;
    }
    const full = await this.atmCosts(rows, u, spot, available, now);
    view.atmCe = full.ce;
    view.atmPe = full.pe;
    view.missing.push(...full.missing);
    const mini = miniUnderlyingOf(u);
    if (mini) {
      const mc = await this.atmCosts(rows, mini, spot, available, now);
      view.mini = { underlying: mini, atmCe: mc.ce, atmPe: mc.pe };
      view.missing.push(...mc.missing);
    }
  }

  /** The ATM CE and PE of `underlying` (nearest expiry) priced at the live premium: 1-lot cost each. */
  private async atmCosts(rows: readonly unknown[], underlying: string, spot: number, available: number | null, now: Date): Promise<{ ce: LotCost | null; pe: LotCost | null; missing: string[] }> {
    const m = this.lotMarket as DeskMarket;
    const missing: string[] = [];
    const contracts: Array<{ kind: 'CE' | 'PE'; c: ResolvedContract }> = [];
    for (const kind of ['CE', 'PE'] as const) {
      const spec = pickContractSpec(rows, { underlying, side: kind === 'CE' ? 'BUY_CE' : 'BUY_PE', strikePolicy: 'ATM', expiryPolicy: 'NEAREST', spot }, now);
      if (!spec.ok) {
        missing.push(`${underlying} ATM ${kind}: ${spec.reason}`);
        continue;
      }
      const r = engineContract(rows, { underlying, instrumentKind: kind, strike: spec.strike, expiry: spec.expiry }, now);
      if (!r.ok) missing.push(`${underlying} ATM ${kind}: ${r.reason}`);
      else if (!(r.contract.lotSize > 0)) missing.push(`${underlying} ATM ${kind}: no lot size in the master`);
      else contracts.push({ kind, c: r.contract });
    }
    const out: { ce: LotCost | null; pe: LotCost | null; missing: string[] } = { ce: null, pe: null, missing };
    if (contracts.length === 0) return out;
    const refs: DeskRef[] = contracts.map(({ c }) => ({ exchange: c.exchange, token: c.token, symbol: c.tradingsymbol }));
    const prices = await m.ltps(refs, now).catch(() => new Map<string, number>());
    for (const { kind, c } of contracts) {
      const premium = prices.get(refKey(c)) ?? null;
      if (premium == null || !(premium > 0)) {
        missing.push(`${c.tradingsymbol}: no fresh premium`);
        continue;
      }
      // `required` exactly as the order path's funds check computes it (requiredFunds: premium x qty x factor + buffer).
      const need = requiredFunds({ side: 'BUY', limitPrice: premium, qty: c.lotSize, exchange: c.exchange, tradingsymbol: c.tradingsymbol }, { instrumentKind: kind, strike: null }, this.fundsCfg());
      const cost = lotCost({ contract: c.tradingsymbol, premium, lotSize: c.lotSize, valueFactor: contractValueFactor(c.exchange, c.tradingsymbol) }, available, need.required);
      if (kind === 'CE') out.ce = cost;
      else out.pe = cost;
    }
    return out;
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
            const v = await timedValue(() => priceAt(r.underlying as string, r.exitAt), DESK_SLOW_BLOCK_MS);
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
          timedValue(() => m.ltp(u, now), DESK_SLOW_BLOCK_MS),
          timedValue(() => m.day(u, now), DESK_SLOW_BLOCK_MS),
          timedValue(() => m.trend15m(u, now), DESK_SLOW_BLOCK_MS),
          timedValue(() => m.levels(u, now), DESK_SLOW_BLOCK_MS),
          timedValue(() => m.chainWalls(u, now), DESK_SLOW_BLOCK_MS),
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
