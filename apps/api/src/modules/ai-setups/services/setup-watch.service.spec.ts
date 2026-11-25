import { PAPER_WATCH_STRATEGIES } from '../../signal-trader/domain/paper';
import { ISOLATED_PAPER_STRATEGIES } from '../../trade-engine/services/risk-manager.service';
import type { SignalTraderConfig } from '../../signal-trader/domain/signal-trader.config';
import { parseSignalTraderConfig } from '../../signal-trader/domain/signal-trader.config';
import type { AiSetupsConfig } from '../ai-setups.config';
import type { SetupPlan } from '../domain/setup.types';
import type { ActiveSetupRow, SetupTradeRow } from '../repositories/ai-setups.repository';
import { SetupWatchService, type SetupWatchMarket, type SetupWatchStore, type WatchRef } from './setup-watch.service';

// 2026-11-25 IST 11:00 = 05:30Z; validUntil 15:15 IST = 09:45Z.
const NOW = new Date('2026-11-25T05:30:00Z');
const LATER = (min: number) => new Date(NOW.getTime() + min * 60_000);
const VALID = new Date('2026-11-25T09:45:00Z');
const CREATED = new Date('2026-11-25T05:00:00Z');

const OPT_TOKEN = '55440';
const MASTER = [
  { token: OPT_TOKEN, symbol: 'DABUR30DEC26440CE', name: 'DABUR', expiry: '30DEC2026', strike: '44000', lotsize: '1250', instrumenttype: 'OPTSTK', exch_seg: 'NFO', tick_size: '5' },
];

const plan = (over: Partial<SetupPlan> = {}): SetupPlan => ({
  instrument: { kind: 'OPT', symbol: 'DABUR', strike: 440, optionType: 'CE', expiry: '2026-12-30' },
  side: 'BUY',
  entry: { type: 'LIMIT_PULLBACK', low: 424, high: 425, trigger: null, level: null },
  sl: 419.5,
  targets: [433.5, 440],
  validUntil: '15:15',
  confidence: 70,
  evidence: [],
  ...over,
});

type Row = ActiveSetupRow & { exitReason?: string | null; exitAt?: Date | null; pnl?: number | null };

/** In-memory ai_setups + trades with the repository's conditional-update semantics (synchronous check-and-set). */
class FakeStore implements SetupWatchStore {
  rows = new Map<string, Row>();
  trades = new Map<string, SetupTradeRow & { entryTags: string[] }>();
  add(r: Partial<Row> & { id: string }): Row {
    const row: Row = { underlying: 'DABUR', status: 'PENDING', setup: plan(), tradeId: null, validUntil: VALID, createdAt: CREATED, entryAt: null, ...r };
    this.rows.set(row.id, row);
    return row;
  }
  async activeSetups() {
    return [...this.rows.values()].filter((r) => r.status === 'PENDING' || r.status === 'FILLED').map((r) => ({ ...r, setup: JSON.parse(JSON.stringify(r.setup)) }));
  }
  async setupState(id: string) {
    const r = this.rows.get(id);
    return r ? { status: r.status, tradeId: r.tradeId } : null;
  }
  private cas(id: string, when: (r: Row) => boolean, set: Partial<Row>): boolean {
    const r = this.rows.get(id);
    if (!r || !when(r)) return false;
    Object.assign(r, set);
    return true;
  }
  async claimFill(id: string, at: Date) {
    return this.cas(id, (r) => r.status === 'PENDING', { status: 'FILLED', entryAt: at });
  }
  async attachTrade(id: string, tradeId: string, setup: unknown) {
    return this.cas(id, (r) => r.status === 'FILLED' && r.tradeId === null, { tradeId, setup });
  }
  async failOpen(id: string, reason: string, at: Date) {
    return this.cas(id, (r) => r.status === 'FILLED' && r.tradeId === null, { status: 'EXPIRED', exitReason: reason, exitAt: at });
  }
  async expire(id: string, reason: string, at: Date) {
    return this.cas(id, (r) => r.status === 'PENDING', { status: 'EXPIRED', exitReason: reason, exitAt: at });
  }
  async saveWatch(id: string, setup: unknown) {
    return this.cas(id, (r) => r.status === 'FILLED', { setup });
  }
  async markExited(id: string, e: { exitReason: string; exitAt: Date; pnl: number | null }) {
    return this.cas(id, (r) => r.status === 'FILLED', { status: 'EXITED', exitReason: e.exitReason, exitAt: e.exitAt, pnl: e.pnl });
  }
  async setupTrade(tradeId: string) {
    const t = this.trades.get(tradeId);
    return t ? { ...t } : null;
  }
  async tradeForSetup(setupId: string) {
    const t = [...this.trades.values()].find((x) => x.entryTags.includes(`setup:${setupId}`));
    return t ? { id: t.id, status: t.status, entryPrice: t.entryPrice } : null;
  }
}

function harness(o: { mode?: 'off' | 'paper'; open?: boolean; minutesToClose?: number | null } = {}) {
  const store = new FakeStore();
  const prices = new Map<string, number>();
  const uKey = 'NSE:1027';
  const oKey = `NFO:${OPT_TOKEN}`;
  let bars: Array<{ ts: number; open: number; high: number; low: number; close: number }> = [];
  const market: SetupWatchMarket = {
    underlyingRef: jest.fn(async (u: string) => (u === 'DABUR' ? { exchange: 'NSE', token: '1027', symbol: 'DABUR' } : null)),
    ltps: jest.fn(async (refs: readonly WatchRef[]) => {
      const m = new Map<string, number>();
      for (const r of refs) {
        const v = prices.get(`${r.exchange}:${r.token}`);
        if (v !== undefined) m.set(`${r.exchange}:${r.token}`, v);
      }
      return m;
    }),
    bars15m: jest.fn(async () => bars),
    master: jest.fn(async () => MASTER),
    isOpen: jest.fn(() => o.open ?? true),
    minutesToClose: jest.fn(() => (o.minutesToClose === undefined ? 120 : o.minutesToClose)),
  } as never;
  let n = 0;
  const paper = {
    open: jest.fn(async (i: { decisionId: string; plan: { ltp: number; tradingsymbol: string; token: string; exchange: string }; brand?: { tags: string[]; strategy: string } }) => {
      n += 1;
      const id = `trade-${n}`;
      store.trades.set(id, {
        id, status: 'OPEN', strategy: i.brand?.strategy ?? null, isPaperTrade: true, exitReasonTag: null, pnl: null, exitTime: null, entryPrice: i.plan.ltp,
        instrument: { token: i.plan.token, exchange: i.plan.exchange, symbol: i.plan.tradingsymbol }, entryTags: i.brand?.tags ?? [],
      });
      return { ok: true as const, tradeId: id, entryPrice: i.plan.ltp };
    }),
  };
  const exec = {
    closeTrade: jest.fn(async (id: string, opts: { exitReasonTag: string; exitPrice?: number }) => {
      const t = store.trades.get(id);
      if (!t || t.status !== 'OPEN') throw new Error(`Cannot close trade with status: ${t?.status}`);
      const px = opts.exitPrice ?? (t.entryPrice as number);
      Object.assign(t, { status: 'CLOSED', exitReasonTag: opts.exitReasonTag, pnl: Math.round((px - (t.entryPrice as number)) * 1250 * 100) / 100, exitTime: NOW });
      return { ...t };
    }),
  };
  const cfg = { mode: o.mode ?? 'paper' } as AiSetupsConfig;
  const traderCfg: SignalTraderConfig = { ...parseSignalTraderConfig({}), ownerUserId: 'owner-1' };
  const make = () => new SetupWatchService(cfg, traderCfg, store, market, paper as never, exec as never);
  return {
    store, market, paper, exec, make, svc: make(),
    setUnderlying: (v: number | null) => (v === null ? prices.delete(uKey) : prices.set(uKey, v)),
    setOption: (v: number | null) => (v === null ? prices.delete(oKey) : prices.set(oKey, v)),
    setBars: (b: typeof bars) => (bars = b),
  };
}

const filledRow = (h: ReturnType<typeof harness>, over: { watch?: Record<string, unknown>; status?: string } = {}) => {
  h.store.trades.set('trade-9', {
    id: 'trade-9', status: over.status ?? 'OPEN', strategy: 'AI_SETUP', isPaperTrade: true, exitReasonTag: null, pnl: null, exitTime: null, entryPrice: 12.4,
    instrument: { token: OPT_TOKEN, exchange: 'NFO', symbol: 'DABUR30DEC26440CE' }, entryTags: ['ai-setup', 'setup:s1'],
  });
  return h.store.add({ id: 's1', status: 'FILLED', tradeId: 'trade-9', entryAt: NOW, setup: { ...plan(), watch: { sl: 419.5, trailed: false, worstFill: 425, ...over.watch } } });
};

describe('SetupWatchService — PENDING', () => {
  it('a pullback fills inside the zone: one PAPER 1-lot option trade, branded AI_SETUP, premium floor SL and no premium target; row FILLED with its trade', async () => {
    const h = harness();
    h.store.add({ id: 's1' });
    h.setUnderlying(429);
    h.setOption(12.4);
    await h.svc.pass(NOW);
    expect(h.paper.open).not.toHaveBeenCalled();
    h.setUnderlying(424.6);
    await h.svc.pass(LATER(1));
    expect(h.paper.open).toHaveBeenCalledTimes(1);
    const arg = h.paper.open.mock.calls[0][0] as unknown as { decisionId: string; plan: Record<string, unknown>; underlying: string; kind: string; strike: number; expiry: string; brand: unknown };
    expect(arg).toMatchObject({ decisionId: 's1', underlying: 'DABUR', kind: 'CE', strike: 440, expiry: '2026-12-30' });
    expect(arg.brand).toEqual({ strategy: 'AI_SETUP', source: 'ai-setup', tags: ['ai-setup', 'setup:s1'], label: 'AI setup' });
    expect(arg.plan).toMatchObject({ tradingsymbol: 'DABUR30DEC26440CE', exchange: 'NFO', token: OPT_TOKEN, ltp: 12.4, lots: 1, qty: 1250, targets: [] });
    // Catastrophe floor: DABUR is a stock option (₹2,000 default ceiling here): 12.4 − 2000 / 1250 = 10.8.
    expect(arg.plan.sl).toBe(10.8);
    const row = h.store.rows.get('s1')!;
    expect(row).toMatchObject({ status: 'FILLED', tradeId: 'trade-1', entryAt: LATER(1) });
    expect((row.setup as { watch: unknown }).watch).toMatchObject({ sl: 419.5, trailed: false, worstFill: 425, entryUnderlying: 424.6, entryPremium: 12.4 });
  });

  it('a gap through the SL before the entry never fills: EXPIRED with the reason, and a later return into the zone does nothing', async () => {
    const h = harness();
    h.store.add({ id: 's1' });
    h.setOption(12.4);
    h.setUnderlying(418);
    await h.svc.pass(NOW);
    expect(h.store.rows.get('s1')).toMatchObject({ status: 'EXPIRED', exitReason: expect.stringMatching(/^SL_CROSSED_BEFORE_ENTRY/) });
    h.setUnderlying(424.5);
    await h.svc.pass(LATER(1));
    expect(h.paper.open).not.toHaveBeenCalled();
  });

  it('validUntil passed → EXPIRED, never filled (even inside the zone, even with the market closed)', async () => {
    const h = harness({ open: false });
    h.store.add({ id: 's1' });
    h.setUnderlying(424.5);
    h.setOption(12.4);
    await h.svc.pass(VALID);
    expect(h.store.rows.get('s1')).toMatchObject({ status: 'EXPIRED', exitReason: expect.stringMatching(/^VALID_UNTIL_PASSED/) });
    expect(h.paper.open).not.toHaveBeenCalled();
  });

  it('market closed (before validUntil): a stale in-zone price never fills', async () => {
    const h = harness({ open: false });
    h.store.add({ id: 's1' });
    h.setUnderlying(424.5);
    h.setOption(12.4);
    await h.svc.pass(NOW);
    expect(h.paper.open).not.toHaveBeenCalled();
    expect(h.store.rows.get('s1')!.status).toBe('PENDING');
  });

  it('a double pass never opens twice (concurrent and sequential)', async () => {
    const h = harness();
    h.store.add({ id: 's1' });
    h.setUnderlying(424.6);
    h.setOption(12.4);
    await Promise.all([h.svc.pass(NOW), h.make().pass(NOW)]);
    await h.svc.pass(LATER(1));
    expect(h.paper.open).toHaveBeenCalledTimes(1);
    expect(h.store.rows.get('s1')!.tradeId).toBe('trade-1');
  });

  it('a failed paper open → EXPIRED with OPEN_FAILED and the reason (never a stuck PENDING / FILLED)', async () => {
    const h = harness();
    h.store.add({ id: 's1' });
    h.setUnderlying(424.6);
    h.setOption(12.4);
    h.paper.open.mockResolvedValueOnce({ ok: false, reason: 'Trade rejected: kill switch' } as never);
    await h.svc.pass(NOW);
    expect(h.store.rows.get('s1')).toMatchObject({ status: 'EXPIRED', exitReason: 'OPEN_FAILED: Trade rejected: kill switch' });
  });

  it('no option price → OPEN_FAILED (never a paper fill on an absent premium)', async () => {
    const h = harness();
    h.store.add({ id: 's1' });
    h.setUnderlying(424.6);
    await h.svc.pass(NOW);
    expect(h.paper.open).not.toHaveBeenCalled();
    expect(h.store.rows.get('s1')).toMatchObject({ status: 'EXPIRED', exitReason: expect.stringMatching(/^OPEN_FAILED: no fresh LTP for DABUR30DEC26440CE/) });
  });

  it('BREAKOUT_TRIGGER needs a closed 15m bar beyond the trigger (read from the 15m loader), never the LTP alone', async () => {
    const h = harness();
    h.store.add({ id: 's1', setup: plan({ entry: { type: 'BREAKOUT_TRIGGER', low: 432, high: 433, trigger: 432, level: 431.5 }, sl: 428, targets: [440] }) });
    h.setUnderlying(433);
    h.setOption(15);
    await h.svc.pass(NOW);
    expect(h.paper.open).not.toHaveBeenCalled();
    expect(h.market.bars15m).toHaveBeenCalled();
    h.setBars([{ ts: new Date('2026-11-25T05:30:00Z').getTime(), open: 431, high: 433, low: 430.5, close: 432.6 }]);
    await h.svc.pass(new Date('2026-11-25T05:45:30Z'));
    expect(h.paper.open).toHaveBeenCalledTimes(1);
  });

  it('every pass reads all prices in ONE batch (underlyings + open options)', async () => {
    const h = harness();
    filledRow(h);
    h.store.add({ id: 's2', underlying: 'DABUR', createdAt: LATER(-10) });
    h.setUnderlying(429);
    h.setOption(13);
    await h.svc.pass(NOW);
    expect(h.market.ltps).toHaveBeenCalledTimes(1);
    const refs = (h.market.ltps as jest.Mock).mock.calls[0][0] as WatchRef[];
    expect(refs.map((r) => `${r.exchange}:${r.token}`).sort()).toEqual([`NFO:${OPT_TOKEN}`, 'NSE:1027']);
  });

  it('mode off → idle (no reads, no opens)', async () => {
    const h = harness({ mode: 'off' });
    const spy = jest.spyOn(h.store, 'activeSetups');
    h.store.add({ id: 's1' });
    h.setUnderlying(424.6);
    await h.svc.pass(NOW);
    expect(spy).not.toHaveBeenCalled();
    expect(h.paper.open).not.toHaveBeenCalled();
  });
});

describe('SetupWatchService — FILLED', () => {
  it('the underlying crossing the SL closes AI_SETUP_SL at the option LTP; row EXITED with the Trade P&L; never twice', async () => {
    const h = harness();
    filledRow(h);
    h.setUnderlying(419.4);
    h.setOption(10.4);
    await h.svc.pass(NOW);
    await h.svc.pass(LATER(1));
    expect(h.exec.closeTrade).toHaveBeenCalledTimes(1);
    expect(h.exec.closeTrade.mock.calls[0][0]).toBe('trade-9');
    expect(h.exec.closeTrade.mock.calls[0][1]).toMatchObject({ exitReasonTag: 'AI_SETUP_SL', exitPrice: 10.4 });
    expect(h.store.rows.get('s1')).toMatchObject({ status: 'EXITED', exitReason: 'AI_SETUP_SL', pnl: -2500 });
  });

  it('exits on the underlying even when the option has no fresh tick (no exitPrice: the paper close falls back)', async () => {
    const h = harness();
    filledRow(h);
    h.setUnderlying(419);
    await h.svc.pass(NOW);
    expect(h.exec.closeTrade).toHaveBeenCalledTimes(1);
    expect((h.exec.closeTrade.mock.calls[0][1] as { exitPrice?: number }).exitPrice).toBeUndefined();
    expect(h.store.rows.get('s1')!.status).toBe('EXITED');
  });

  it('T1 trails the SL to the worst-fill entry level (stored), then the last target closes AI_SETUP_TARGET', async () => {
    const h = harness();
    filledRow(h);
    h.setOption(16);
    h.setUnderlying(433.6);
    await h.svc.pass(NOW);
    expect(h.exec.closeTrade).not.toHaveBeenCalled();
    expect((h.store.rows.get('s1')!.setup as { watch: Record<string, unknown> }).watch).toMatchObject({ sl: 425, trailed: true });
    h.setOption(19);
    h.setUnderlying(440.2);
    await h.svc.pass(LATER(5));
    expect(h.exec.closeTrade).toHaveBeenCalledTimes(1);
    expect(h.exec.closeTrade.mock.calls[0][1]).toMatchObject({ exitReasonTag: 'AI_SETUP_TARGET', exitPrice: 19 });
    expect(h.store.rows.get('s1')).toMatchObject({ status: 'EXITED', exitReason: 'AI_SETUP_TARGET' });
  });

  it('validUntil / session end close AI_SETUP_TIME', async () => {
    const h = harness();
    filledRow(h);
    h.setUnderlying(428);
    await h.svc.pass(VALID);
    expect(h.exec.closeTrade.mock.calls[0][1]).toMatchObject({ exitReasonTag: 'AI_SETUP_TIME' });
    const h2 = harness({ minutesToClose: 5 });
    filledRow(h2);
    h2.setUnderlying(428);
    await h2.svc.pass(NOW);
    expect(h2.store.rows.get('s1')).toMatchObject({ status: 'EXITED', exitReason: 'AI_SETUP_TIME' });
  });

  it('a trade closed elsewhere (paper sentinel / floor / kill switch) → EXITED with that reason and the Trade P&L, no second close', async () => {
    const h = harness();
    filledRow(h);
    Object.assign(h.store.trades.get('trade-9')!, { status: 'CLOSED', exitReasonTag: 'AI_EXIT', pnl: -812.5, exitTime: LATER(-2) });
    h.setUnderlying(419); // would be an SL exit
    await h.svc.pass(NOW);
    expect(h.exec.closeTrade).not.toHaveBeenCalled();
    expect(h.store.rows.get('s1')).toMatchObject({ status: 'EXITED', exitReason: 'AI_EXIT', pnl: -812.5, exitAt: LATER(-2) });
  });

  it('restart mid-FILLED resumes from the DB: a new instance honours the stored trailed SL', async () => {
    const h = harness();
    filledRow(h, { watch: { sl: 425, trailed: true } });
    h.setUnderlying(424.8);
    h.setOption(12.9);
    await h.make().pass(NOW);
    expect(h.exec.closeTrade).toHaveBeenCalledTimes(1);
    expect(h.store.rows.get('s1')).toMatchObject({ status: 'EXITED', exitReason: 'AI_SETUP_SL' });
  });

  it('restart between the claim and the attach: the tagged trade is re-attached; none found → EXPIRED OPEN_INTERRUPTED', async () => {
    const h = harness();
    h.store.trades.set('trade-7', {
      id: 'trade-7', status: 'OPEN', strategy: 'AI_SETUP', isPaperTrade: true, exitReasonTag: null, pnl: null, exitTime: null, entryPrice: 12.4,
      instrument: { token: OPT_TOKEN, exchange: 'NFO', symbol: 'DABUR30DEC26440CE' }, entryTags: ['ai-setup', 'setup:s1'],
    });
    h.store.add({ id: 's1', status: 'FILLED', tradeId: null, entryAt: LATER(-2) });
    h.store.add({ id: 's2', status: 'FILLED', tradeId: null, entryAt: LATER(-2), underlying: 'DABUR' });
    h.setUnderlying(428);
    await h.make().pass(NOW);
    expect(h.paper.open).not.toHaveBeenCalled();
    expect(h.store.rows.get('s1')).toMatchObject({ status: 'FILLED', tradeId: 'trade-7' });
    expect((h.store.rows.get('s1')!.setup as { watch: unknown }).watch).toMatchObject({ sl: 419.5, worstFill: 425 });
    expect(h.store.rows.get('s2')).toMatchObject({ status: 'EXPIRED', exitReason: expect.stringMatching(/^OPEN_INTERRUPTED/) });
  });

  it('never closes a trade that is not a paper AI_SETUP trade', async () => {
    const h = harness();
    filledRow(h);
    Object.assign(h.store.trades.get('trade-9')!, { isPaperTrade: false });
    h.setUnderlying(419);
    await h.svc.pass(NOW);
    expect(h.exec.closeTrade).not.toHaveBeenCalled();
    expect(h.store.rows.get('s1')!.status).toBe('FILLED');
  });
});

describe('AI_SETUP in the paper watch', () => {
  it('the generic paper watch + paper sentinel manage AI_SETUP paper trades too (premium floor, square-off, AI exits)', () => {
    expect(PAPER_WATCH_STRATEGIES).toContain('AI_SETUP');
  });
});

describe('SetupWatchService — fix round 1', () => {
  it('AI_SETUP paper trades have their own concurrent-positions pool (stale scanner paper trades cannot block them)', () => {
    expect(ISOLATED_PAPER_STRATEGIES.has('AI_SETUP')).toBe(true);
  });

  it('no underlying line in the master → EXPIRED NO_UNDERLYING_REF; a failed lookup only waits', async () => {
    const h = harness();
    h.store.add({ id: 's1', underlying: 'NOSUCH' });
    await h.svc.pass(NOW);
    expect(h.store.rows.get('s1')).toMatchObject({ status: 'EXPIRED', exitReason: expect.stringMatching(/^NO_UNDERLYING_REF/) });
    const h2 = harness();
    h2.store.add({ id: 's1' });
    (h2.market.underlyingRef as jest.Mock).mockRejectedValueOnce(new Error('master down'));
    await h2.svc.pass(NOW);
    expect(h2.store.rows.get('s1')!.status).toBe('PENDING');
  });

  it('interleaving: while A is inside the paper open, B (a claim younger than 60 s) does nothing; A attaches', async () => {
    const h = harness();
    h.store.add({ id: 's1' });
    h.setUnderlying(424.6);
    h.setOption(12.4);
    const realOpen = h.paper.open.getMockImplementation()!;
    h.paper.open.mockImplementationOnce(async (i) => {
      // Process B passes 10 s after A's claim, before A's open returns.
      await h.make().pass(LATER(10 / 60));
      expect(h.store.rows.get('s1')).toMatchObject({ status: 'FILLED', tradeId: null });
      return realOpen(i);
    });
    await h.svc.pass(NOW);
    expect(h.paper.open).toHaveBeenCalledTimes(1);
    expect(h.store.rows.get('s1')).toMatchObject({ status: 'FILLED', tradeId: 'trade-1' });
    expect(h.exec.closeTrade).not.toHaveBeenCalled();
  });

  it('an attach that fails because the row moved closes the just-opened paper trade at once (AI_SETUP_ORPHANED)', async () => {
    const h = harness();
    h.store.add({ id: 's1' });
    h.setUnderlying(424.6);
    h.setOption(12.4);
    const realOpen = h.paper.open.getMockImplementation()!;
    h.paper.open.mockImplementationOnce(async (i) => {
      // A slow open: another process recovered the stale claim meanwhile (EXPIRED OPEN_INTERRUPTED).
      h.store.rows.get('s1')!.status = 'EXPIRED';
      return realOpen(i);
    });
    await h.svc.pass(NOW);
    expect(h.exec.closeTrade).toHaveBeenCalledTimes(1);
    expect(h.exec.closeTrade.mock.calls[0][0]).toBe('trade-1');
    expect(h.exec.closeTrade.mock.calls[0][1]).toMatchObject({ exitReasonTag: 'AI_SETUP_ORPHANED' });
    expect(h.store.trades.get('trade-1')!.status).toBe('CLOSED');
  });

  it('a close another closer claimed first: the row takes THEIR reason and P&L', async () => {
    const h = harness();
    filledRow(h);
    h.setUnderlying(419);
    h.exec.closeTrade.mockResolvedValueOnce({ status: 'CLOSED', exitReasonTag: 'AI_EXIT', pnl: -300, exitTime: LATER(-1) } as never);
    await h.svc.pass(NOW);
    expect(h.store.rows.get('s1')).toMatchObject({ status: 'EXITED', exitReason: 'AI_EXIT', pnl: -300, exitAt: LATER(-1) });
  });
});

describe('SetupWatchService — fix round 2', () => {
  it('a close lost to another closer\'s PARTIAL close leaves the row FILLED (the trade is still open)', async () => {
    const h = harness();
    filledRow(h);
    h.setUnderlying(419);
    h.exec.closeTrade.mockResolvedValueOnce({ status: 'PARTIALLY_FILLED', exitReasonTag: null, pnl: -100, exitTime: null } as never);
    await h.svc.pass(NOW);
    expect(h.store.rows.get('s1')).toMatchObject({ status: 'FILLED', tradeId: 'trade-9' });
    // Next pass: the trade still open and the SL still crossed → closes it for real.
    await h.svc.pass(LATER(1));
    expect(h.store.rows.get('s1')).toMatchObject({ status: 'EXITED', exitReason: 'AI_SETUP_SL' });
  });
});
