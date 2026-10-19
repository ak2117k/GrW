import { Logger } from '@nestjs/common';
import { parseExitDisciplineConfig } from '../../exit-discipline/config';
import { parseMbmConfig } from '../../mbm/mbm.config';
import type { MbmBehaviour } from '../../mbm/services/mbm-client.service';
import { ExitGateService } from './exit-gate.service';

// MBM M3 stream A §2: MBM_EXIT_SHADOW records beside the exit-gate decision, never in it.
const NOW = new Date('2026-10-14T05:01:20Z');
const verdict = (symbol: string) => ({ id: 'cur', userId: 'owner', trackerId: 't1', symbol, reason: 'r', createdAt: new Date('2026-10-14T05:01:00Z') });
const packet = (symbol: string, underlying: number) => ({
  position: { symbol, side: 'LONG', qty: 75, entryPrice: 120, ltp: 131, expiry: '2026-10-28', underlyingLtp: { available: true, value: underlying } },
  money: { charges: 61, netPnl: 760, greenFloorPrice: 125, greenFloorArmed: true, floorBasis: 'noise' },
  thesis: { available: true, value: { invalidation: underlying - 80 } },
  structure: { levelBook: { available: true, value: { vwap: underlying - 5, atr14: 190 } } },
  flow: { noiseUnit: { available: true, value: { contract: { n: 2.5, method: 'atr14-1m', bars: 14, at: 'x' }, underlying: null } } },
  session: { nowUtc: '2026-10-14T05:00:30Z' },
});
const NIFTY_SYM = 'NIFTY28OCT2625000CE';
const OK: MbmBehaviour = {
  instrument: 'NIFTY', status: 'ok', asOf: '2026-10-14T04:45:00Z',
  horizons: { '60m': { p: 0.857, regime: 'ACTIVE', q25Bp: 37, q50Bp: 51, q75Bp: 68 }, '30m': { p: 0.6, regime: 'NORMAL', q25Bp: 20, q50Bp: 28, q75Bp: 41 } },
};
const live = (exchange = 'NFO') => ({ ltpNow: 130.5, productType: 'CARRYFORWARD', exchange, now: NOW });

function make(o: { env?: Record<string, string>; symbol?: string; answer?: () => Promise<MbmBehaviour>; underlying?: number; noMbm?: boolean } = {}) {
  const symbol = o.symbol ?? NIFTY_SYM;
  const repo = {
    verdictPacket: jest.fn(async () => packet(symbol, o.underlying ?? 25100)),
    recentVerdicts: jest.fn(async () => [
      { id: 'h', verdict: 'HOLD', createdAt: new Date('2026-10-14T04:50:00Z'), underlying: 25090, support: 25000, resistance: 25200 },
    ]),
    maxRiskPerTrade: jest.fn(async () => 2000),
    dailyLossLatched: jest.fn(async () => false),
  };
  const clock = { minutesToClose: jest.fn(() => 268) };
  const behaviour = jest.fn(o.answer ?? (async () => OK));
  const svc = new ExitGateService(
    repo as never, clock as never, parseExitDisciplineConfig({}),
    o.env === undefined ? undefined : parseMbmConfig({ MBM_FEED_USER_ID: 'o', ...o.env }),
    o.noMbm ? undefined : ({ behaviour } as never),
  );
  return { svc, behaviour, v: verdict(symbol) };
}
/** The gate's record with no MBM wired at all — today's behaviour. */
async function baseline(symbol = NIFTY_SYM, exchange = 'NFO') {
  const { svc, v } = make({ symbol });
  return svc.decide(await svc.load(v as never, NOW), live(exchange));
}

let logSpy: jest.SpyInstance;
beforeEach(() => { logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined); });
afterEach(() => logSpy.mockRestore());
const shadowLogs = () => logSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('[mbm-exit-shadow]'));

describe('MBM_EXIT_SHADOW off: the record is unchanged and MBM is never asked', () => {
  it.each<[string, Record<string, string> | undefined]>([
    ['no MBM config wired', undefined],
    ['MBM_EXIT_SHADOW unset', { MBM_ENABLED: 'observe' }],
    ['MBM_EXIT_SHADOW=off', { MBM_ENABLED: 'observe', MBM_EXIT_SHADOW: 'off' }],
    ['MBM_ENABLED=off overrides MBM_EXIT_SHADOW=on', { MBM_EXIT_SHADOW: 'on' }],
  ])('%s', async (_n, env) => {
    const { svc, behaviour, v } = make({ env });
    const r = svc.decide(await svc.load(v as never, NOW), live());
    expect(r).toEqual(await baseline());
    expect('mbmShadow' in r).toBe(false);
    expect(behaviour).not.toHaveBeenCalled();
    expect(shadowLogs()).toEqual([]);
  });
});

describe.each(['observe', 'on'])('MBM_EXIT_SHADOW=%s (both only record)', (mode) => {
  const env = { MBM_ENABLED: 'observe', MBM_EXIT_SHADOW: mode };

  it('NIFTY option: the decision is byte-identical; the shadow and its log line sit beside it', async () => {
    const { svc, behaviour, v } = make({ env });
    const r = svc.decide(await svc.load(v as never, NOW), live());
    const { mbmShadow, ...rest } = r;
    expect(rest).toEqual(await baseline());
    expect(behaviour).toHaveBeenCalledWith('NIFTY', NOW.getTime());
    const noiseTrail = Math.round(r.cfg.floorTrailN * r.facts!.nUnderlying! * 100) / 100;
    expect(mbmShadow).toEqual({
      v: 1, i: 'NIFTY', outcome: r.outcome, usable: true, h: '60m', regime: 'ACTIVE', p: 0.86, asOf: OK.asOf,
      rangeBp: [37, 51, 68], rangePts: [92.87, 128.01, 170.68],
      noiseTrailPts: noiseTrail, mbmTrailVsNoise: Math.round((128.01 / noiseTrail) * 100) / 100,
    });
    expect(shadowLogs()).toEqual([`[mbm-exit-shadow] ${NIFTY_SYM} verdict cur ${JSON.stringify(mbmShadow)}`]);
  });

  it.each<[string, () => Promise<MbmBehaviour>, string]>([
    ['stale', async () => ({ ...OK, status: 'stale' }), 'not-ok'],
    ['absent', async () => ({ status: 'absent' }), 'not-ok'],
    ['a rejecting client', async () => { throw new Error('down'); }, 'not-ok'],
    ['an answer that has not arrived', () => new Promise<MbmBehaviour>(() => undefined), 'pending'],
  ])('%s ⇒ a reason, never a would-value; decision unchanged', async (_n, answer, why) => {
    const { svc, v } = make({ env, answer });
    const r = svc.decide(await svc.load(v as never, NOW), live());
    const { mbmShadow, ...rest } = r;
    expect(rest).toEqual(await baseline());
    expect(mbmShadow).toEqual({ v: 1, i: 'NIFTY', outcome: r.outcome, usable: false, why });
  });

  it('non-NIFTY (MCX) positions are never asked and carry no shadow', async () => {
    const { svc, behaviour, v } = make({ env, symbol: 'CRUDEOIL17NOV269000CE' });
    const r = svc.decide(await svc.load(v as never, NOW), live('MCX'));
    expect(r).toEqual(await baseline('CRUDEOIL17NOV269000CE', 'MCX'));
    expect(behaviour).not.toHaveBeenCalled();
  });

  it('the live exchange is authoritative: an F&O-looking symbol that is not NFO/BFO gets no shadow', async () => {
    const { svc, v } = make({ env });
    const r = svc.decide(await svc.load(v as never, NOW), live('MCX'));
    expect('mbmShadow' in r).toBe(false);
  });

  it('unreadable facts (BYPASS) carry no shadow', async () => {
    const { svc } = make({ env });
    const r = svc.decide({ kind: 'unreadable', reason: 'x' }, live());
    expect(r.outcome).toBe('BYPASS');
    expect('mbmShadow' in r).toBe(false);
  });

  it('no client wired ⇒ inert', async () => {
    const { svc, v } = make({ env, noMbm: true });
    const r = svc.decide(await svc.load(v as never, NOW), live());
    expect(r).toEqual(await baseline());
  });
});
