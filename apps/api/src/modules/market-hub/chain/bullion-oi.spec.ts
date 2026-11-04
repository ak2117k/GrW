import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { oiCheck } from '../../signal-trader/domain/oi-check';
import { oiCoreUnderlyings } from '../market-hub.service';
import { SessionClock } from '../session-clock';
import { MemoryChainRepo } from '../testing/memory-chain-repo';
import type { ChainContract, HubChain } from './chain.types';
import { ChainService } from './chain-service';
import { OiSnapshotJob } from './oi-snapshot-job';

/**
 * 2026-11-04 (US midterm results): oi_check for the GOLD27NOV26 150000 CE channel call read
 * "NO_DATA: no option chain in oi_snapshots" — GOLD / SILVER were never snapshot targets. They now
 * join the core list (HUB_OI_BULLION_ENABLED), through the same REST snapshot path as CRUDEOIL.
 */
const IST = (local: string) => Date.parse(`${local}Z`) - 5.5 * 3600_000;
const GOLD_EXP = '2026-11-27';
const STRIKES = Array.from({ length: 11 }, (_, i) => 135000 + i * 1000); // 135000 … 145000
const goldContract = (strike: number, optionType: 'CE' | 'PE'): ChainContract => ({
  instrumentId: `g${strike}${optionType}`,
  ref: { exchange: 'MCX', token: `G${strike}${optionType}`, symbol: `GOLD27NOV26${strike}${optionType}` },
  strike,
  optionType,
  lotSize: 1,
});
const GOLD_CONTRACTS = STRIKES.flatMap((k) => [goldContract(k, 'CE'), goldContract(k, 'PE')]);
const leg = (token: string, oi: number) => ({ ltp: 500, oi, oiChange: null, volume: 10, iv: 15, delta: 0, gamma: 0, theta: 0, vega: 0, bidPrice: 0, askPrice: 0, token, lotSize: 1 });

describe('GOLD / SILVER option chains into oi_snapshots', () => {
  it('the core list carries GOLD and SILVER while the bullion switch is on (off = today’s list)', () => {
    expect(oiCoreUnderlyings('NIFTY,CRUDEOIL', true, true)).toEqual(['NIFTY', 'CRUDEOIL', 'SENSEX', 'GOLD', 'SILVER']);
    expect(oiCoreUnderlyings('NIFTY,CRUDEOIL', true)).toEqual(['NIFTY', 'CRUDEOIL', 'SENSEX']);
    expect(oiCoreUnderlyings('GOLD', false, true)).toEqual(['GOLD', 'SILVER']);
  });

  it('resolves GOLD’s and SILVER’s nearest option expiry as snapshot targets (GOLDM is not pulled in)', async () => {
    const now = IST('2026-11-04T11:00:00');
    const expiries: Record<string, string[]> = { GOLD: [GOLD_EXP, '2026-12-31'], SILVER: [GOLD_EXP], GOLDM: ['2026-11-25'] };
    const svc = new ChainService({
      builder: {
        contracts: async (u) => (u === 'GOLD' ? GOLD_CONTRACTS : []),
        expiries: async (u) => expiries[u] ?? [],
        contractFor: async () => null,
        build: async () => ({ kind: 'unavailable', reason: 'not used' }),
        baselineFailures: 0,
      },
      repo: new MemoryChainRepo(),
      clock: new SessionClock({ holidays: MARKET_HOLIDAYS }),
      strikesAround: 20,
      watchContract: jest.fn(),
      priceOf: () => ({ kind: 'unavailable', reason: 'never-priced' }),
      quoteNow: async () => new Map(),
      now: () => now,
      snapshots: { core: oiCoreUnderlyings('', false, true) },
    });
    const t = await svc.snapshotTargets(now);
    expect(t.map((x) => `${x.underlying}:${x.expiry}`)).toEqual([`GOLD:${GOLD_EXP}`, `SILVER:${GOLD_EXP}`]);
  });

  describe('snapshot rows → oiCheck', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('3-minute GOLD snapshots from the MCX open give oiCheck a chain verdict, not NO_DATA', async () => {
      const repo = new MemoryChainRepo();
      const open = IST('2026-11-04T09:00:00');
      // Put writers add OI through the morning, call OI flat: a bullish chain lean.
      const chainAt = (at: number): HubChain => {
        const step = Math.round((at - open) / 180_000);
        return {
          underlying: 'GOLD', expiry: GOLD_EXP, exchange: 'MCX', spot: 140350, at, greeks: 'broker',
          entries: STRIKES.map((k) => ({ strikePrice: k, expiryDate: GOLD_EXP, ceData: leg(`G${k}CE`, 1000), peData: leg(`G${k}PE`, 1000 + step * 20) })),
        };
      };
      const job = new OiSnapshotJob({
        targets: async () => [{ underlying: 'GOLD', expiry: GOLD_EXP }],
        contracts: async () => GOLD_CONTRACTS,
        freshChain: async () => chainAt(Date.now()),
        repo,
        clock: new SessionClock({ holidays: MARKET_HOLIDAYS }),
      });
      for (let t = IST('2026-11-04T09:03:00'); t <= IST('2026-11-04T11:00:00'); t += 180_000) {
        jest.setSystemTime(t);
        await job.tick(Date.now());
      }
      expect(repo.oiRows.length).toBeGreaterThan(22 * 30);

      const check = oiCheck({
        at: new Date(IST('2026-11-04T11:01:33')),
        want: 'BULLISH',
        sessionStart: new Date(open),
        chain: {
          expiry: GOLD_EXP,
          contracts: GOLD_CONTRACTS.map((c) => ({ instrumentId: c.instrumentId, strike: c.strike, optionType: c.optionType })),
          rows: repo.oiRows.map((r) => ({ instrumentId: r.instrumentId, oi: r.oi, at: r.at })),
          center: 140350,
          centerSource: 'option_chain_snapshots spot',
        },
        futures: null,
      });
      expect(check.verdict).not.toBe('NO_DATA');
      expect(check.verdict).toBe('AGREES');
      expect(check.source).toBe('CHAIN');
    });
  });
});
