import { parseSignalTraderConfig } from '../../signal-trader/domain/signal-trader.config';
import { parseDeskManagerConfig } from '../desk-manager.config';
import { validateDecision } from '../domain/decision-validate';
import type { ActionContext, DeskPacket, InstrumentView } from '../domain/desk.types';
import type { PendingEntryRow } from '../repositories/desk-actions.repository';
import type { DeskMarket, DeskRef } from './desk-actions.ports';
import { DeskActionsService, watchPacket, type OpenDecision } from './desk-actions.service';

/**
 * Fix round 1 (W2 review): the packet keys instruments by the parent (CRUDEOILM -> CRUDEOIL, GOLDM -> GOLD) and the
 * prompt asks for the mini when the full lot does not fit. An OPEN on the mini must pass validation against the
 * parent's prices AND resolve the mini's own contract.
 */
const NOW = new Date('2026-11-26T08:30:00.000Z'); // 14:00 IST, MCX open
const OWNER = 'owner-1';
const ENV = { SENTINEL_TRIGGERS_ENABLED: 'true', AI_AUTO_EXIT_ENABLED: 'true', AI_AUTO_EXIT_MODE: 'live', AI_AUTO_EXIT_USER_IDS: OWNER, AI_AUTO_EXIT_QTY_UNITS: 'NFO:units,BFO:units,MCX:lots' };

const row = (name: string, sym: string, strike: number, kind: 'CE' | 'PE', lot: string, expiry: string) => ({
  token: `${name}-${strike}${kind}`,
  symbol: `${name}${sym}${strike}${kind}`,
  name,
  expiry,
  strike: String(strike * 100),
  lotsize: lot,
  instrumenttype: 'OPTFUT',
  exch_seg: 'MCX',
  tick_size: '10',
});
const MASTER = [
  ...[5200, 5300].flatMap((s) => (['CE', 'PE'] as const).flatMap((k) => [row('CRUDEOIL', '16DEC26', s, k, '100', '16DEC2026'), row('CRUDEOILM', '16DEC26', s, k, '10', '16DEC2026')])),
  ...[130000, 131000].flatMap((s) => (['CE', 'PE'] as const).flatMap((k) => [row('GOLD', '24DEC26', s, k, '1', '24DEC2026'), row('GOLDM', '24DEC26', s, k, '1', '24DEC2026')])),
];

const view = (u: string, ltp: number): InstrumentView => ({ underlying: u, ltp, dayOpen: null, dayHigh: null, dayLow: null, vwap: null, trend15m: null, levels: [], chainWalls: null, missing: [] });
const packetWith = (inst: Record<string, InstrumentView>): DeskPacket => ({ ...watchPacket(NOW, 'live'), instruments: { status: 'present', value: inst, source: 'test' } });

function setup(busy = new Map<string, string>()) {
  const cfg = parseDeskManagerConfig({ DESK_MANAGER: 'live', HUB_OWNER_USER_ID: OWNER, HARD_LOSS_CEILING_BY_CLASS: 'MCX:3000,GOLD:3000,GOLD_MINI:3000' });
  const rows = new Map<string, PendingEntryRow>();
  let seq = 0;
  const store = {
    entriesToday: jest.fn(async () => 0),
    busyUnderlyings: jest.fn(async () => busy),
    insertPending: jest.fn(async (r: Omit<PendingEntryRow, 'id' | 'createdAt' | 'orderRowId' | 'tradeId'> & { result?: unknown }) => {
      const id = `row-${++seq}`;
      rows.set(id, { id, createdAt: NOW, orderRowId: null, tradeId: null, ...r, result: r.result ?? null });
      return id;
    }),
    move: jest.fn(async () => true),
  };
  const prices = new Map<string, number>([
    ['MCX:CRUDE-FUT', 5210],
    ['MCX:GOLD-FUT', 130200],
    ['MCX:CRUDEOILM-5200CE', 38],
    ['MCX:CRUDEOIL-5200CE', 385],
    ['MCX:GOLDM-130000CE', 120],
    ['MCX:GOLD-130000CE', 1200],
  ]);
  const market: DeskMarket = {
    // The live market resolves a mini to its parent's line (vocabulary CRUDEOILM -> CRUDEOIL).
    underlyingRef: jest.fn(async (u: string) => (u.startsWith('CRUDE') ? { exchange: 'MCX', token: 'CRUDE-FUT', symbol: u } : { exchange: 'MCX', token: 'GOLD-FUT', symbol: u })),
    ltps: jest.fn(async (refs: readonly DeskRef[]) => new Map(refs.flatMap((r) => (prices.has(`MCX:${r.token}`) ? [[`MCX:${r.token}`, prices.get(`MCX:${r.token}`) as number] as const] : [])))),
    master: jest.fn(async () => MASTER),
    isOpen: jest.fn(() => true),
    minutesToClose: jest.fn(() => 300),
  };
  const place = jest.fn(async () => ({ kind: 'PLACED', orderRowId: 'ord-1', brokerOrderId: 'B1' }));
  const guard = { check: jest.fn(async () => ({ blocked: false, reasons: [], path: { realised: 0, open: 0, total: 0, peak: 0, drawdownFromPeak: 0, lossStreak: 0, closed: [] }, pausedUntil: null, pauseScope: null })), pause: jest.fn(), resume: jest.fn() };
  const exits = { exit: jest.fn(), tighten: jest.fn() };
  const svc = new DeskActionsService(cfg, parseSignalTraderConfig({}), store as never, market, { place } as never, { open: jest.fn() } as never, { ltp: jest.fn(async (_owner: string, token: string) => prices.get(`MCX:${token}`) ?? null) }, { available: async () => 30_000 }, guard as never, exits as never, undefined, undefined, ENV);
  const ctx = (packet: DeskPacket): ActionContext => ({ runId: 'run-1', decisionId: 'dec-1', now: NOW, packet, cfg });
  return { svc, place, ctx, store };
}

const open = (underlying: string, spot: number, stop: number, t1: number): OpenDecision =>
  ({
    action: 'OPEN', underlying, side: 'BUY_CE', strikePolicy: 'ATM', expiryPolicy: 'NEAREST',
    entry: { type: 'NOW', validMin: 30 }, stop: { underlying: stop }, targets: { underlying: [t1] },
    confidence: 'medium', reason: 'full lot does not fit, the mini does', evidence: [`ltp ${spot}`],
  }) as OpenDecision;

describe('OPEN on an MCX mini (packet keyed by the parent)', () => {
  it('CRUDEOILM: valid against instruments.CRUDEOIL and resolves the CRUDEOILM contract', async () => {
    const packet = packetWith({ CRUDEOIL: view('CRUDEOIL', 5210) });
    const d = open('CRUDEOILM', 5210, 5190, 5250);
    expect(validateDecision(d, packet)).toEqual([]);
    const t = setup();
    const r = await t.svc.execute(d, t.ctx(packet));
    expect(t.place).toHaveBeenCalledTimes(1);
    const arg = (t.place.mock.calls[0] as unknown[])[0] as { plan: { tradingsymbol: string; lotSize: number } };
    expect(arg.plan.tradingsymbol).toBe('CRUDEOILM16DEC265200CE');
    expect(r.status).not.toBe('FAILED');
  });

  it('GOLDM: valid against instruments.GOLD and resolves the GOLDM contract', async () => {
    const packet = packetWith({ GOLD: view('GOLD', 130200) });
    const d = open('GOLDM', 130200, 130100, 130400);
    expect(validateDecision(d, packet)).toEqual([]);
    const t = setup();
    await t.svc.execute(d, t.ctx(packet));
    const arg = (t.place.mock.calls[0] as unknown[])[0] as { plan: { tradingsymbol: string } };
    expect(arg.plan.tradingsymbol).toBe('GOLDM24DEC26130000CE');
  });

  it('an underlying not in the packet at all is still invalid', () => {
    expect(validateDecision(open('SILVERM', 1, 0, 3), packetWith({ GOLD: view('GOLD', 130200) }))).toEqual(['underlying SILVERM not in packet.instruments']);
  });

  it('a mini and its parent are one underlying: an open CRUDEOIL position refuses a CRUDEOILM OPEN', async () => {
    const t = setup(new Map([['CRUDEOIL', 'open position CRUDEOIL16DEC265200CE (tracker k1)']]));
    const r = await t.svc.execute(open('CRUDEOILM', 5210, 5190, 5250), t.ctx(packetWith({ CRUDEOIL: view('CRUDEOIL', 5210) })));
    expect(r.status).toBe('REFUSED');
    expect(r.detail).toContain('already has open position CRUDEOIL');
    expect(t.place).not.toHaveBeenCalled();
  });
});
