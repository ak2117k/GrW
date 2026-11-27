import { parseSignalTraderConfig } from '../../signal-trader/domain/signal-trader.config';
import { parseDeskManagerConfig, type DeskManagerConfig } from '../desk-manager.config';
import type { ActionContext, GuardState, ManagerDecision } from '../domain/desk.types';
import type { PendingEntryRow } from '../repositories/desk-actions.repository';
import type { DeskMarket, DeskRef } from './desk-actions.ports';
import { DESK_RUNNER_HEALTH } from './desk-actions.ports';
import { DeskActionsService, watchPacket, type OpenDecision } from './desk-actions.service';
import { PendingEntryWatchService } from './pending-entry-watch.service';

// 2026-11-26 11:00 IST (a Thursday; NSE open).
const NOW = new Date('2026-11-26T05:30:00.000Z');
const OWNER = 'owner-1';
const ENV = {
  SENTINEL_TRIGGERS_ENABLED: 'true',
  AI_AUTO_EXIT_ENABLED: 'true',
  AI_AUTO_EXIT_MODE: 'live',
  AI_AUTO_EXIT_USER_IDS: OWNER,
  AI_AUTO_EXIT_QTY_UNITS: 'NFO:units,BFO:units,MCX:lots',
};

const optRow = (strike: number, kind: 'CE' | 'PE', token: string) => ({
  exch_seg: 'NFO', name: 'NIFTY', instrumenttype: 'OPTIDX', symbol: `NIFTY02DEC26${strike}${kind}`, token, expiry: '02DEC2026', strike: String(strike * 100), lotsize: '75', tick_size: '5',
});
const MASTER = [optRow(25900, 'CE', '501'), optRow(26000, 'CE', '502'), optRow(26100, 'CE', '503'), optRow(26000, 'PE', '602')];
const NIFTY_REF: DeskRef = { exchange: 'NSE', token: '26000', symbol: 'NIFTY' };

function cfgOf(mode: 'live' | 'shadow' | 'off'): DeskManagerConfig {
  return parseDeskManagerConfig({ DESK_MANAGER: mode, HUB_OWNER_USER_ID: OWNER });
}

function open(over: Partial<OpenDecision> = {}): OpenDecision {
  return {
    action: 'OPEN', underlying: 'NIFTY', side: 'BUY_CE', strikePolicy: 'ATM', expiryPolicy: 'NEAREST',
    entry: { type: 'NOW', validMin: 30 }, stop: { underlying: 25980 }, targets: { underlying: [26080, 26140] },
    confidence: 'high', reason: 'break and hold above 26000', evidence: ['ltp 26020', 'level 26000'], ...over,
  } as OpenDecision;
}

function setup(o: { mode?: 'live' | 'shadow' | 'off'; spot?: number; premium?: number; guard?: Partial<GuardState>; entries?: number; busy?: Map<string, string>; minutesToClose?: number | null; health?: boolean; place?: jest.Mock; authority?: boolean } = {}) {
  const cfg = cfgOf(o.mode ?? 'live');
  const rows = new Map<string, PendingEntryRow>();
  let seq = 0;
  const store = {
    entriesToday: jest.fn(async () => o.entries ?? 0),
    busyUnderlyings: jest.fn(async () => o.busy ?? new Map<string, string>()),
    insertPending: jest.fn(async (r: Omit<PendingEntryRow, 'id' | 'createdAt' | 'orderRowId' | 'tradeId'> & { result?: unknown }) => {
      if ([...rows.values()].some((x) => x.decisionId === r.decisionId)) return null;
      const id = `row-${++seq}`;
      rows.set(id, { id, createdAt: NOW, orderRowId: null, tradeId: null, ...r, result: r.result ?? null });
      return id;
    }),
    move: jest.fn(async (id: string, from: string, to: string, data: { result?: unknown; orderRowId?: string | null; tradeId?: string | null } = {}) => {
      const r = rows.get(id);
      if (!r || r.status !== from) return false;
      rows.set(id, { ...r, status: to, ...(data.result !== undefined ? { result: data.result } : {}), ...(data.orderRowId !== undefined ? { orderRowId: data.orderRowId } : {}), ...(data.tradeId !== undefined ? { tradeId: data.tradeId } : {}) });
      return true;
    }),
    pendingRows: jest.fn(async () => [...rows.values()].filter((r) => r.status === 'PENDING')),
    filledSince: jest.fn(async () => [...rows.values()].filter((r) => r.status === 'FILLED')),
    setResult: jest.fn(async (id: string, result: unknown) => {
      const r = rows.get(id);
      if (r) rows.set(id, { ...r, result });
    }),
    orderTracker: jest.fn(async () => ({ status: 'FILLED', trackerId: 'trk-1' })),
    updateDecision: jest.fn(async () => undefined),
  };
  const prices = new Map<string, number>([['NSE:26000', o.spot ?? 26020], ['NFO:502', o.premium ?? 100], ['NFO:602', 90]]);
  const market: DeskMarket & { prices: Map<string, number> } = {
    prices,
    underlyingRef: jest.fn(async () => NIFTY_REF),
    ltps: jest.fn(async (refs: readonly DeskRef[]) => {
      const m = new Map<string, number>();
      for (const r of refs) {
        const k = `${r.exchange.toUpperCase()}:${r.token}`;
        const v = prices.get(k);
        if (v !== undefined) m.set(k, v);
      }
      return m;
    }),
    master: jest.fn(async () => MASTER),
    isOpen: jest.fn(() => true),
    minutesToClose: jest.fn(() => (o.minutesToClose === undefined ? 120 : o.minutesToClose)),
  };
  const place = o.place ?? jest.fn(async () => ({ kind: 'PLACED', orderRowId: 'ord-1', brokerOrderId: 'B1' }));
  const paper = { open: jest.fn(async () => ({ ok: true, tradeId: 'trade-1', entryPrice: 100 })) };
  const quotes = { ltp: jest.fn(async () => o.premium ?? 100) };
  const funds = { available: jest.fn(async () => 1_000_000) };
  const guardState: GuardState = { blocked: false, reasons: [], path: { realised: 0, open: 0, total: 0, peak: 0, drawdownFromPeak: 0, lossStreak: 0, closed: [] }, pausedUntil: null, pauseScope: null, ...o.guard };
  const guard = { check: jest.fn(async () => guardState), pause: jest.fn(async () => undefined), resume: jest.fn(async () => undefined) };
  const exits = { exit: jest.fn(async () => ({ status: 'DONE' as const, detail: 'exit sent' })), tighten: jest.fn(async () => ({ status: 'RECORDED' as const, detail: 'trigger armed', ref: 'v-1' })) };
  const moduleRef = { get: jest.fn(() => ({ opensBlocked: () => o.health === true })) };
  const traderCfg = parseSignalTraderConfig({});
  // Trade agent exit authority: undefined = ports absent (today), true / false = AUTHORITY_STATE.isLive().
  const briefs = { write: jest.fn(async () => undefined) };
  const authority = o.authority === undefined ? undefined : { isLive: () => o.authority as boolean };
  const briefPort = o.authority === undefined ? undefined : briefs;
  const svc = new DeskActionsService(cfg, traderCfg, store as never, market, { place } as never, paper as never, quotes, funds, guard, exits, undefined, moduleRef as never, ENV, briefPort, authority);
  const ctx = (decisionId = 'dec-1'): ActionContext => ({ runId: 'run-1', decisionId, now: NOW, packet: watchPacket(NOW, cfg.mode), cfg });
  const watch = new PendingEntryWatchService(cfg, store as never, market, svc, exits, briefPort, authority);
  return { svc, store, market, place, paper, guard, exits, moduleRef, rows, ctx, watch, cfg, briefs };
}

describe('DeskActionsService OPEN', () => {
  it('refuses a second entry on the same underlying', async () => {
    const t = setup({ busy: new Map([['NIFTY', 'open position NIFTY02DEC2626000PE (tracker trk-9)']]) });
    const r = await t.svc.execute(open(), t.ctx());
    expect(r.status).toBe('REFUSED');
    expect(r.detail).toContain('NIFTY already has open position');
    expect(t.place).not.toHaveBeenCalled();
  });

  it('refuses in the last 30 min', async () => {
    const t = setup({ minutesToClose: 25 });
    const r = await t.svc.execute(open(), t.ctx());
    expect(r).toMatchObject({ status: 'REFUSED' });
    expect(r.detail).toContain('last 30 min');
  });

  it('refuses before live start on NSE', async () => {
    const t = setup();
    const early = new Date('2026-11-26T03:50:00.000Z'); // 09:20 IST
    const r = await t.svc.execute(open(), { ...t.ctx(), now: early });
    expect(r.status).toBe('REFUSED');
    expect(r.detail).toContain('before SIGNAL_LIVE_FROM_IST 09:45');
  });

  it('refuses when the venue is closed', async () => {
    const t = setup();
    (t.market.isOpen as jest.Mock).mockReturnValue(false);
    expect((await t.svc.execute(open(), t.ctx())).detail).toContain('NFO is closed');
  });

  it('refuses when guard blocked', async () => {
    const t = setup({ guard: { blocked: true, reasons: ['3 losers in a row ≥ 3'] } });
    const r = await t.svc.execute(open(), t.ctx());
    expect(r).toEqual({ status: 'REFUSED', detail: 'desk guard: 3 losers in a row ≥ 3' });
    expect(t.guard.check).toHaveBeenCalledWith(OWNER, 'manager', 'NIFTY', NOW);
  });

  it('refuses at 5 entries today', async () => {
    const t = setup({ entries: 5 });
    expect((await t.svc.execute(open(), t.ctx())).detail).toContain('5 manager entries today');
  });

  it('refuses when the runner health blocks opens', async () => {
    const t = setup({ health: true });
    expect((await t.svc.execute(open(), t.ctx())).detail).toContain('opens blocked');
    expect(t.moduleRef.get).toHaveBeenCalledWith(DESK_RUNNER_HEALTH, { strict: false });
  });

  it('refuses an underlying the owner put on the HOLD list by name', async () => {
    const t = setup();
    const svc = new DeskActionsService(t.cfg, parseSignalTraderConfig({}), t.store as never, t.market, { place: t.place } as never, t.paper as never, { ltp: async () => 100 }, undefined, t.guard, t.exits, undefined, undefined, { ...ENV, AI_AUTO_EXIT_HOLD: 'BSE,NIFTY' });
    expect((await svc.execute(open(), t.ctx())).detail).toContain('hold list');
  });

  it('a held CONTRACT blocks only while it is an open position (2026-11-27: expired NIFTY09NOV2624300CE blocked every NIFTY open)', async () => {
    const env = { ...ENV, AI_AUTO_EXIT_HOLD: 'NIFTY09NOV2624300CE,MAZDOCK29DEC261760PE' };
    const closed = setup();
    const svc = new DeskActionsService(closed.cfg, parseSignalTraderConfig({}), closed.store as never, closed.market, { place: closed.place } as never, closed.paper as never, { ltp: async () => 100 }, undefined, closed.guard, closed.exits, undefined, undefined, env);
    expect((await svc.execute(open(), closed.ctx())).detail ?? '').not.toContain('hold list');
    // Still open → the open-position rule refuses it (one position per underlying).
    const held = setup({ busy: new Map([['NIFTY', 'open position NIFTY02DEC2626000PE (tracker k9)']]) });
    const svc2 = new DeskActionsService(held.cfg, parseSignalTraderConfig({}), held.store as never, held.market, { place: held.place } as never, held.paper as never, { ltp: async () => 100 }, undefined, held.guard, held.exits, undefined, undefined, env);
    expect((await svc2.execute(open(), held.ctx())).detail).toContain('already has open position');
  });

  it('refuses when the 1-lot loss is above the class ceiling (never shrunk)', async () => {
    const t = setup();
    // 26020 → 25800: 220 × 0.5 × 75 + 1 × 75 = 8325 > INDEX_OPT 5000.
    const r = await t.svc.execute(open({ stop: { underlying: 25800 } }), t.ctx());
    expect(r.status).toBe('REFUSED');
    expect(r.detail).toContain('₹8325');
    expect(r.detail).toContain('₹5000 class ceiling');
    expect(t.place).not.toHaveBeenCalled();
    expect([...t.rows.values()][0].status).toBe('REFUSED');
  });

  it('NOW live calls place with source manager and no paper fallback on REJECTED', async () => {
    const place = jest.fn(async () => ({ kind: 'REJECTED', orderRowId: 'ord-1', reason: 'insufficient margin' }));
    const t = setup({ place });
    const r = await t.svc.execute(open(), t.ctx());
    expect(place).toHaveBeenCalledTimes(1);
    const arg = (place.mock.calls[0] as unknown[])[0] as Record<string, any>;
    expect(arg).toMatchObject({ decisionId: 'dec-1', ownerUserId: OWNER, source: 'manager', underlying: 'NIFTY', channel: 'desk-manager' });
    expect(arg.onRejected).toBeUndefined();
    expect(arg.plan).toMatchObject({ tradingsymbol: 'NIFTY02DEC2626000CE', lots: 1, qty: 75, side: 'BUY' });
    // premium SL = 100 − (40 × 0.5 × 75 + 1 × 75) / 75 = 100 − 21 = 79.
    expect(arg.plan.sl).toBe(79);
    expect(r.status).toBe('REFUSED');
    expect(r.detail).toContain('insufficient margin');
    expect(t.paper.open).not.toHaveBeenCalled();
    expect([...t.rows.values()][0].status).toBe('REFUSED');
  });

  it('NOW live PLACED → DONE, row FILLED with the stop waiting', async () => {
    const t = setup();
    const r = await t.svc.execute(open(), t.ctx());
    expect(r).toMatchObject({ status: 'DONE', ref: 'ord-1' });
    const row = [...t.rows.values()][0];
    expect(row).toMatchObject({ status: 'FILLED', orderRowId: 'ord-1' });
    expect((row.result as any).stop).toEqual({ underlying: 25980, state: 'WAITING' });
  });

  it('live refuses when funds are short (no mini swap)', async () => {
    const t = setup();
    const svc = new DeskActionsService(t.cfg, parseSignalTraderConfig({}), t.store as never, t.market, { place: t.place } as never, t.paper as never, { ltp: async () => 100 }, { available: async () => 100 }, t.guard, t.exits, undefined, undefined, ENV);
    const r = await svc.execute(open(), t.ctx());
    expect(r.status).toBe('REFUSED');
    expect(r.detail).toMatch(/^funds:/);
    expect(t.place).not.toHaveBeenCalled();
  });

  it('NOW shadow opens paper with the DESK_MANAGER brand', async () => {
    const t = setup({ mode: 'shadow' });
    const r = await t.svc.execute(open(), t.ctx());
    expect(r).toMatchObject({ status: 'DONE', ref: 'trade-1' });
    expect(t.place).not.toHaveBeenCalled();
    expect(t.guard.check).not.toHaveBeenCalled();
    const arg = (t.paper.open.mock.calls[0] as unknown[])[0] as Record<string, any>;
    expect(arg.brand).toEqual({ strategy: 'DESK_MANAGER', source: 'desk-manager', tags: ['desk-manager', 'desk-decision:dec-1'], label: 'Desk manager' });
    expect(arg).toMatchObject({ underlying: 'NIFTY', kind: 'CE', strike: 26000, expiry: '2026-12-02' });
  });

  it('shadow refuses BUY_FUT', async () => {
    const t = setup({ mode: 'shadow' });
    expect((await t.svc.execute(open({ side: 'BUY_FUT' }), t.ctx())).detail).toContain('BUY_FUT refused');
  });
});

describe('pending entries', () => {
  const zone = () => open({ entry: { type: 'ZONE', low: 25990, high: 26005, validMin: 30 } });

  it('ZONE creates PENDING and the watch fires inside the zone', async () => {
    const t = setup({ spot: 26020 });
    const r = await t.svc.execute(zone(), t.ctx());
    expect(r.status).toBe('PENDING');
    expect([...t.rows.values()][0]).toMatchObject({ status: 'PENDING', validUntil: new Date(NOW.getTime() + 30 * 60_000) });
    expect(t.place).not.toHaveBeenCalled();

    await t.watch.pass(new Date(NOW.getTime() + 5_000)); // 26020: outside the zone
    expect(t.place).not.toHaveBeenCalled();

    t.market.prices.set('NSE:26000', 26000);
    await t.watch.pass(new Date(NOW.getTime() + 10_000));
    expect(t.place).toHaveBeenCalledTimes(1);
    expect([...t.rows.values()][0]).toMatchObject({ status: 'FILLED', orderRowId: 'ord-1' });
    expect(t.store.updateDecision).toHaveBeenCalledWith('dec-1', expect.objectContaining({ status: 'DONE', orderRowId: 'ord-1' }));
    // The fire re-ran the checks with this decision excluded.
    expect(t.store.entriesToday).toHaveBeenLastCalledWith(OWNER, expect.any(Date), 'dec-1');
  });

  it('BREAKOUT expires at validUntil', async () => {
    const t = setup({ spot: 26020 });
    await t.svc.execute(open({ entry: { type: 'BREAKOUT', triggerAbove: 26100, validMin: 15 } }), t.ctx());
    await t.watch.pass(new Date(NOW.getTime() + 15 * 60_000));
    expect([...t.rows.values()][0].status).toBe('EXPIRED');
    expect(t.place).not.toHaveBeenCalled();
    expect(t.store.updateDecision).toHaveBeenCalledWith('dec-1', expect.objectContaining({ status: 'REFUSED' }));
  });

  it('BREAKOUT fires at the trigger', async () => {
    const t = setup({ spot: 26020 });
    await t.svc.execute(open({ entry: { type: 'BREAKOUT', triggerAbove: 26030, validMin: 15 } }), t.ctx());
    t.market.prices.set('NSE:26000', 26035);
    await t.watch.pass(new Date(NOW.getTime() + 5_000));
    expect(t.place).toHaveBeenCalledTimes(1);
  });

  it('pending claim prevents double fire', async () => {
    const t = setup({ spot: 26000 });
    await t.svc.execute(zone(), t.ctx());
    const later = new Date(NOW.getTime() + 5_000);
    await Promise.all([t.watch.pass(later), t.watch.pass(later)]);
    expect(t.place).toHaveBeenCalledTimes(1);
  });

  it('a fire that fails a check at fire time is REFUSED', async () => {
    const t = setup({ spot: 26000 });
    await t.svc.execute(zone(), t.ctx());
    (t.market.minutesToClose as jest.Mock).mockReturnValue(10);
    await t.watch.pass(new Date(NOW.getTime() + 5_000));
    expect(t.place).not.toHaveBeenCalled();
    expect([...t.rows.values()][0].status).toBe('REFUSED');
  });

  it('arms the underlying stop once the tracker exists', async () => {
    const t = setup();
    await t.svc.execute(open(), t.ctx());
    await t.watch.pass(new Date(NOW.getTime() + 5_000));
    expect(t.exits.tighten).toHaveBeenCalledWith('trk-1', 25980, expect.stringContaining('initial stop'), expect.objectContaining({ decisionId: 'dec-1', runId: 'run-1' }));
    expect((([...t.rows.values()][0].result as any).stop)).toMatchObject({ state: 'ARMED', ref: 'v-1' });
    await t.watch.pass(new Date(NOW.getTime() + 10_000));
    expect(t.exits.tighten).toHaveBeenCalledTimes(1);
  });

  it('shadow arms the stop on the paper tracker', async () => {
    const t = setup({ mode: 'shadow' });
    await t.svc.execute(open(), t.ctx());
    await t.watch.pass(new Date(NOW.getTime() + 5_000));
    expect(t.exits.tighten).toHaveBeenCalledWith('paper:trade-1', 25980, expect.any(String), expect.any(Object));
  });
});

describe('other actions', () => {
  const why = { reason: 'r', evidence: ['x 1'] };

  it('EXIT / TIGHTEN delegate to the exit actions', async () => {
    const t = setup();
    await t.svc.execute({ action: 'EXIT', trackerId: 'trk-1', ...why } as ManagerDecision, t.ctx());
    await t.svc.execute({ action: 'TIGHTEN', trackerId: 'trk-1', underlyingStop: 26000, ...why } as ManagerDecision, t.ctx());
    expect(t.exits.exit).toHaveBeenCalledWith('trk-1', 'EXIT', 'r', expect.any(Object));
    expect(t.exits.tighten).toHaveBeenCalledWith('trk-1', 26000, 'r', expect.any(Object));
  });

  it('PAUSE / RESUME: live → guard, shadow → recorded only', async () => {
    const live = setup();
    expect(await live.svc.execute({ action: 'PAUSE_ENTRIES', scope: 'NIFTY', minutes: 30, ...why } as ManagerDecision, live.ctx())).toMatchObject({ status: 'DONE' });
    expect(live.guard.pause).toHaveBeenCalledWith(OWNER, 'NIFTY', 30, NOW);
    const shadow = setup({ mode: 'shadow' });
    expect(await shadow.svc.execute({ action: 'RESUME', ...why } as ManagerDecision, shadow.ctx())).toMatchObject({ status: 'RECORDED' });
    expect(shadow.guard.resume).not.toHaveBeenCalled();
  });

  it('WATCH / NO_ACTION are recorded', async () => {
    const t = setup();
    expect((await t.svc.execute({ action: 'NO_ACTION', ...why } as ManagerDecision, t.ctx())).status).toBe('RECORDED');
  });
});

describe('trade briefs (trade agent exit authority)', () => {
  const TEXT = 'Plan: hold for 26080 while 15m closes stay above 25980; book at 26140.';
  const brief = (trackerId = 'trk-1'): ManagerDecision => ({ action: 'BRIEF', trackerId, text: TEXT, reason: 'trade brief', evidence: [] });

  it('a DONE live OPEN writes a brief composed from the decision once its tracker exists (by OPEN)', async () => {
    const t = setup({ authority: true });
    const r = await t.svc.execute(open({ proposalRef: 'reading:42' }), t.ctx());
    expect(r.status).toBe('DONE');
    await t.watch.pass(new Date(NOW.getTime() + 5_000));
    expect(t.briefs.write).toHaveBeenCalledTimes(1);
    const [trackerId, userId, text, by] = t.briefs.write.mock.calls[0] as unknown as [string, string, string, string];
    expect([trackerId, userId, by]).toEqual(['trk-1', OWNER, 'OPEN']);
    for (const s of ['BUY_CE NIFTY', 'NIFTY02DEC2626000CE', 'NOW on NIFTY', 'Stop (underlying): 25980', 'Targets (underlying): 26080 / 26140', 'break and hold above 26000', 'ltp 26020; level 26000', 'Lead: reading:42', 'decision dec-1']) {
      expect(text).toContain(s);
    }
    expect(([...t.rows.values()][0].result as any).brief).toEqual({ state: 'WRITTEN' });
    // The stop is still armed; the next pass writes nothing again.
    expect(t.exits.tighten).toHaveBeenCalledTimes(1);
    await t.watch.pass(new Date(NOW.getTime() + 10_000));
    expect(t.briefs.write).toHaveBeenCalledTimes(1);
  });

  it('a brief write failure never blocks the stop', async () => {
    const t = setup({ authority: true });
    t.briefs.write.mockRejectedValueOnce(new Error('db down') as never);
    await t.svc.execute(open(), t.ctx());
    await t.watch.pass(new Date(NOW.getTime() + 5_000));
    const res = [...t.rows.values()][0].result as any;
    expect(res.stop.state).toBe('ARMED');
    expect(res.brief).toEqual(expect.objectContaining({ state: 'FAILED' }));
  });

  it('off (isLive false or ports absent) and shadow paper OPENs: no brief', async () => {
    for (const t of [setup({ authority: false }), setup(), setup({ mode: 'shadow', authority: true })]) {
      await t.svc.execute(open(), t.ctx());
      await t.watch.pass(new Date(NOW.getTime() + 5_000));
      expect(t.briefs.write).not.toHaveBeenCalled();
      expect(([...t.rows.values()][0].result as any).brief).toBeUndefined();
    }
  });

  it('the BRIEF action writes via TRADE_BRIEFS by MANAGER (live)', async () => {
    const t = setup({ authority: true });
    const r = await t.svc.execute(brief(), t.ctx());
    expect(r.status).toBe('DONE');
    expect(t.briefs.write).toHaveBeenCalledWith('trk-1', OWNER, TEXT, 'MANAGER');
  });

  it('the BRIEF action: authority off → REFUSED, desk shadow → RECORDED, nothing written', async () => {
    const off = setup({ authority: false });
    expect((await off.svc.execute(brief(), off.ctx())).status).toBe('REFUSED');
    const none = setup();
    expect((await none.svc.execute(brief(), none.ctx())).status).toBe('REFUSED');
    const shadow = setup({ mode: 'shadow', authority: true });
    expect((await shadow.svc.execute(brief(), shadow.ctx())).status).toBe('RECORDED');
    for (const t of [off, none, shadow]) expect(t.briefs.write).not.toHaveBeenCalled();
  });
});
