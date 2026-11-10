import { SignalContextService } from './signal-context.service';
import { missingBlocks } from '../../self-review/decisions/detectors';

/**
 * Self-review ticket 2026-11-06 "judge packet built without the mbm block": every packet carried mbm as
 * `unavailable` (the owner's MBM_PACKET gate, or a non-NIFTY underlying) and CRUDEOIL's chain as
 * "nothing available (not wired, or no data)" — by-design absences read as data gaps by INPUT_MISSING.
 * By design ⇒ `not_applicable` with the reason; a chain snapshot carries its age so a days-old one is visible.
 */
const NOW = new Date('2026-11-06T08:59:06Z');

function make(o: { packet?: 'off' | 'observe' | 'on'; chain?: unknown } = {}) {
  const chain = { latestChain: jest.fn().mockResolvedValue(o.chain ?? null) };
  const mbm = { behaviour: jest.fn().mockResolvedValue({ status: 'ok', horizons: {} }) };
  const mbmCfg = { instruments: ['NIFTY'], packet: o.packet ?? 'observe' };
  const svc = new SignalContextService(chain as any, undefined, undefined, undefined, mbm as any, mbmCfg as any);
  return { svc, chain, mbm };
}

const build = (svc: SignalContextService, underlying: string, kind: string, exchange: string) =>
  svc.build({ underlying, kind, exchange, ownerUserId: 'owner', now: NOW, ltp: 100 });

describe('SignalContextService.build — by-design absences are explicit, not data gaps', () => {
  it('mbm on a non-MBM underlying (stock / MCX) is not_applicable with the reason', async () => {
    const { svc, mbm } = make({ packet: 'on' });
    for (const [u, k, ex] of [['MCX', 'CE', 'NFO'], ['CRUDEOIL', 'PE', 'MCX']]) {
      const ctx = await build(svc, u, k, ex);
      expect(ctx.mbm).toEqual({ status: 'not_applicable', reason: expect.stringContaining(`${u} is not an MBM instrument`) });
    }
    expect(mbm.behaviour).not.toHaveBeenCalled();
  });

  it('mbm withheld by the owner gate (MBM_PACKET != on) is not_applicable, naming the gate', async () => {
    const { svc } = make({ packet: 'observe' });
    const ctx = await build(svc, 'NIFTY', 'CE', 'NFO');
    expect(ctx.mbm).toEqual({ status: 'not_applicable', reason: expect.stringContaining('MBM_PACKET') });
  });

  it('mbm on NIFTY with the gate on is present', async () => {
    const { svc } = make({ packet: 'on' });
    const ctx = await build(svc, 'NIFTY', 'CE', 'NFO');
    expect(ctx.mbm.status).toBe('present');
  });

  it('chain on an MCX commodity without the hub-capture reader stays unavailable (never not_applicable), with the reason', async () => {
    const { svc, chain } = make();
    const ctx = await build(svc, 'CRUDEOIL', 'PE', 'MCX');
    expect(ctx.chain).toEqual({ status: 'unavailable', reason: expect.stringContaining('not wired') });
    expect(chain.latestChain).not.toHaveBeenCalled();
  });

  it('chain with no snapshot for an NFO underlying stays unavailable, with an explicit reason', async () => {
    const { svc } = make();
    const ctx = await build(svc, 'TIINDIA', 'CE', 'NFO');
    expect(ctx.chain).toEqual({ status: 'unavailable', reason: expect.stringContaining('no snapshot for TIINDIA') });
  });

  it('a present chain block carries its age in minutes', async () => {
    const capturedAt = new Date(NOW.getTime() - 2 * 86_400_000);
    const { svc } = make({ chain: { expiry: '2026-11-25', capturedAt, spot: 3500, fut: null, pcr: 1, maxPain: 3400, callWall: 3600, putWall: 3300 } });
    const ctx = await build(svc, 'MCX', 'CE', 'NFO');
    expect(ctx.chain.status).toBe('present');
    expect((ctx.chain as any).value.ageMin).toBe(2 * 24 * 60);
  });

  it('the night review (INPUT_MISSING) counts unavailable blocks but not not_applicable ones', async () => {
    const { svc } = make({ packet: 'observe' });
    const ctx = await build(svc, 'CRUDEOIL', 'PE', 'MCX');
    const miss = missingBlocks('judge', ctx);
    expect(miss).not.toContain('mbm');
    expect(miss).toContain('chain'); // no hub capture to read: a real gap, never not_applicable
  });
});

/**
 * 2026-11-10: the MCX chain is read from the market hub's own 3-minute OI capture (oi_snapshots),
 * database only — the same block shape as the NSE snapshot, ATM centred on the option's underlying FUTURE.
 */
describe('SignalContextService.build — the MCX chain from the hub OI capture', () => {
  const NOW_MCX = new Date('2026-11-10T09:00:00Z'); // 14:30 IST
  const CAP = new Date('2026-11-10T08:57:00Z');
  const strikes = [5300, 5400, 5500, 5600, 5700];
  const contracts = (expiry: string) =>
    strikes.flatMap((k) => [
      { instrumentId: `${expiry}:${k}CE`, strike: k, optionType: 'CE' as const },
      { instrumentId: `${expiry}:${k}PE`, strike: k, optionType: 'PE' as const },
    ]);
  const rowsFor = (expiry: string) =>
    strikes.flatMap((k) => [
      { instrumentId: `${expiry}:${k}CE`, oi: k === 5700 ? 3000 : 500, oiChange: 100, volume: 5, ltp: Math.max(5, 160 - (k - 5500) * 0.6) },
      { instrumentId: `${expiry}:${k}PE`, oi: k === 5400 ? 2500 : 400, oiChange: -20, volume: 5, ltp: Math.max(5, 130 + (k - 5500) * 0.6) },
    ]);

  function makeRepo(o: { captured?: string[]; bars?: Array<{ at: Date; close: number }> } = {}) {
    const captured = new Set(o.captured ?? ['2026-11-17']);
    return {
      optionExpiries: jest.fn().mockResolvedValue(['2026-11-17', '2026-12-16']),
      mcxFutures: jest.fn().mockResolvedValue([
        { exchange: 'MCX', token: 'F-NOV', symbol: 'CRUDEOIL26NOVFUT', expiry: '2026-11-19' },
        { exchange: 'MCX', token: 'F-DEC', symbol: 'CRUDEOIL26DECFUT', expiry: '2026-12-18' },
      ]),
      optionContracts: jest.fn().mockImplementation(async (_n: string, e: string) => contracts(e)),
      latestOiCapture: jest.fn().mockImplementation(async (ids: string[]) => {
        const e = ids[0].split(':')[0];
        return captured.has(e) ? { at: CAP, rows: rowsFor(e) } : null;
      }),
      minuteCloses: jest.fn().mockResolvedValue(o.bars ?? [{ at: new Date('2026-11-10T08:56:00Z'), close: 5512 }]),
    };
  }
  const svcWith = (repo: unknown) => new SignalContextService(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, repo as any);
  const buildMcx = (svc: SignalContextService, expiry?: string) => svc.build({ underlying: 'CRUDEOIL', kind: 'PE', exchange: 'MCX', ownerUserId: 'owner', now: NOW_MCX, ltp: 100, expiry });

  it('is present, in the NSE shape, with its age, centred on the underlying future', async () => {
    const repo = makeRepo();
    const ctx = await buildMcx(svcWith(repo));
    expect(ctx.chain.status).toBe('present');
    const b = ctx.chain as { source: string; value: Record<string, unknown> };
    expect(b.source).toContain('oi_snapshots');
    expect(b.value).toMatchObject({
      expiry: '2026-11-17',
      capturedAt: CAP.toISOString(),
      ageMin: 3,
      spot: 5512,
      fut: null,
      callWall: 5700,
      putWall: 5400,
      exchange: 'MCX',
      underlyingFuture: 'CRUDEOIL26NOVFUT',
    });
    expect(typeof b.value.pcr).toBe('number');
    expect(typeof b.value.maxPain).toBe('number');
    // the price is the Nov future's 1-min close at the capture, not any spot index
    expect(repo.minuteCloses).toHaveBeenCalledWith('MCX', 'F-NOV', new Date(CAP.getTime() - 10 * 60_000), CAP);
    const miss = missingBlocks('judge', ctx);
    expect(miss).not.toContain('chain');
  });

  it('reads the traded expiry first; its future is that month\'s', async () => {
    const repo = makeRepo({ captured: ['2026-11-17', '2026-12-16'] });
    const ctx = await buildMcx(svcWith(repo), '2026-12-16');
    const v = (ctx.chain as { value: Record<string, unknown> }).value;
    expect(v.expiry).toBe('2026-12-16');
    expect(v.underlyingFuture).toBe('CRUDEOIL26DECFUT');
  });

  it('falls to the nearest expiry when the traded one was never captured', async () => {
    const ctx = await buildMcx(svcWith(makeRepo()), '2026-12-16');
    expect((ctx.chain as { value: Record<string, unknown> }).value.expiry).toBe('2026-11-17');
  });

  it('no 1-min bar of the future: priced by put-call parity from the capture', async () => {
    const ctx = await buildMcx(svcWith(makeRepo({ bars: [] })));
    const v = (ctx.chain as { value: Record<string, unknown> }).value;
    expect(v.spot).toBe(5530);
    expect(String(v.spotSource)).toContain('parity');
  });

  it('nothing captured (e.g. CRUDEOILM, not in the hub core list): unavailable, naming why', async () => {
    const ctx = await buildMcx(svcWith(makeRepo({ captured: [] })));
    expect(ctx.chain).toEqual({ status: 'unavailable', reason: expect.stringContaining('no oi_snapshots capture') });
    expect(missingBlocks('judge', ctx)).toContain('chain');
  });

  it('a failing read is unavailable with the error, never a throw', async () => {
    const repo = makeRepo();
    repo.latestOiCapture.mockRejectedValue(new Error('db down'));
    const ctx = await buildMcx(svcWith(repo));
    expect(ctx.chain).toEqual({ status: 'unavailable', reason: expect.stringContaining('db down') });
  });
});

/**
 * A mini / variant (CRUDEOILM → CRUDEOIL, …): the hub captures its own chain only while held / viewed;
 * when that capture is missing or older than the parent's, the parent's chain at the matching expiry is
 * read instead, labelled proxyOf, with the parent's future. Still database only.
 */
describe('SignalContextService.build — an MCX mini reads its parent chain as a labelled proxy', () => {
  const NOW_MCX = new Date('2026-11-10T09:00:00Z');
  const PARENT_AT = new Date('2026-11-10T08:57:00Z');
  const strikes = [5300, 5400, 5500, 5600, 5700];
  const contracts = (key: string) =>
    strikes.flatMap((k) => [
      { instrumentId: `${key}:${k}CE`, strike: k, optionType: 'CE' as const },
      { instrumentId: `${key}:${k}PE`, strike: k, optionType: 'PE' as const },
    ]);
  const rowsFor = (key: string) =>
    strikes.flatMap((k) => [
      { instrumentId: `${key}:${k}CE`, oi: k === 5700 ? 3000 : 500, oiChange: 100, volume: 5, ltp: Math.max(5, 160 - (k - 5500) * 0.6) },
      { instrumentId: `${key}:${k}PE`, oi: k === 5400 ? 2500 : 400, oiChange: -20, volume: 5, ltp: Math.max(5, 130 + (k - 5500) * 0.6) },
    ]);

  function makeRepo(o: { miniAt?: Date | null; parentExpiries?: string[] } = {}) {
    const expiries: Record<string, string[]> = { CRUDEOILM: ['2026-11-17'], CRUDEOIL: o.parentExpiries ?? ['2026-11-17', '2026-12-16'] };
    const futures: Record<string, Array<{ exchange: string; token: string; symbol: string; expiry: string }>> = {
      CRUDEOILM: [{ exchange: 'MCX', token: 'M-NOV', symbol: 'CRUDEOILM26NOVFUT', expiry: '2026-11-19' }],
      CRUDEOIL: [
        { exchange: 'MCX', token: 'F-NOV', symbol: 'CRUDEOIL26NOVFUT', expiry: '2026-11-19' },
        { exchange: 'MCX', token: 'F-DEC', symbol: 'CRUDEOIL26DECFUT', expiry: '2026-12-18' },
      ],
    };
    const at: Record<string, Date | null> = { CRUDEOILM: o.miniAt ?? null, CRUDEOIL: PARENT_AT };
    return {
      optionExpiries: jest.fn().mockImplementation(async (n: string) => expiries[n] ?? []),
      mcxFutures: jest.fn().mockImplementation(async (n: string) => futures[n] ?? []),
      optionContracts: jest.fn().mockImplementation(async (n: string, e: string) => contracts(`${n}|${e}`)),
      latestOiCapture: jest.fn().mockImplementation(async (ids: string[]) => {
        const key = ids[0].split(':')[0];
        const when = at[key.split('|')[0]];
        return when ? { at: when, rows: rowsFor(key) } : null;
      }),
      minuteCloses: jest.fn().mockResolvedValue([{ at: new Date('2026-11-10T08:56:00Z'), close: 5512 }]),
    };
  }
  const svcWith = (repo: unknown) => new SignalContextService(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, repo as any);
  const buildMini = (svc: SignalContextService) => svc.build({ underlying: 'CRUDEOILM', kind: 'CE', exchange: 'MCX', ownerUserId: 'owner', now: NOW_MCX, ltp: 100, expiry: '2026-11-17' });
  const value = (ctx: Record<string, unknown>) => (ctx.chain as { value: Record<string, unknown> }).value;

  it("no own capture: the parent's chain at the matching expiry, proxyOf + the parent's future", async () => {
    const ctx = await buildMini(svcWith(makeRepo()));
    expect(ctx.chain.status).toBe('present');
    expect(value(ctx)).toMatchObject({ proxyOf: 'CRUDEOIL', expiry: '2026-11-17', underlyingFuture: 'CRUDEOIL26NOVFUT', capturedAt: PARENT_AT.toISOString(), exchange: 'MCX' });
    expect(missingBlocks('judge', ctx)).not.toContain('chain');
  });

  it("an own capture older than the parent's: the parent's", async () => {
    const ctx = await buildMini(svcWith(makeRepo({ miniAt: new Date('2026-11-09T17:00:00Z') })));
    expect(value(ctx).proxyOf).toBe('CRUDEOIL');
  });

  it('an own capture as new as the parent\'s: its own chain, no proxyOf', async () => {
    const ctx = await buildMini(svcWith(makeRepo({ miniAt: PARENT_AT })));
    expect(value(ctx).proxyOf).toBeUndefined();
    expect(value(ctx).underlyingFuture).toBe('CRUDEOILM26NOVFUT');
  });

  it("the parent's matching expiry is the nearest on or after the mini's", async () => {
    const ctx = await buildMini(svcWith(makeRepo({ parentExpiries: ['2026-11-10', '2026-12-16'] })));
    expect(value(ctx)).toMatchObject({ proxyOf: 'CRUDEOIL', expiry: '2026-12-16', underlyingFuture: 'CRUDEOIL26DECFUT' });
  });

  it('no parent expiry on or after the mini\'s and no own capture: unavailable, naming both', async () => {
    const ctx = await buildMini(svcWith(makeRepo({ parentExpiries: ['2026-11-10'] })));
    expect(ctx.chain).toEqual({ status: 'unavailable', reason: expect.stringMatching(/no oi_snapshots capture.*CRUDEOIL proxy: no CRUDEOIL option expiry on or after 2026-11-17/) });
  });
});
