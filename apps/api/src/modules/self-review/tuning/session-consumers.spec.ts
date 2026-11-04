import { parseExitDisciplineConfig, SPIKE_BANK_RISE_N, SPIKE_BANK_TRAIL_N, withSessionExitTuning } from '../../exit-discipline/config';
import { parseCarryConfig, withCarryTuning } from '../../intraday-carry/domain/carry-config';
import { parseSignalTraderConfig, withSignalTuning } from '../../signal-trader/domain/signal-trader.config';
import { solveCycleSpike } from '../../trade-sentinel/services/cycle-spike';
import { DEFAULT_TUNING, type TunableValue, type TuningReader } from './tunables';

const reader = (vals: Record<string, TunableValue>): TuningReader => ({
  get: <T extends TunableValue>(target: string, fallback: T): T => (target in vals && typeof vals[target] === typeof fallback ? (vals[target] as T) : fallback),
});
const throwing: TuningReader = { get: () => { throw new Error('boom'); } };

describe('wrong-decision loop tunables at their consumers (2026-11-05)', () => {
  describe('signal judge', () => {
    const env = { SIGNAL_JUDGE_MIN_CONFIDENCE: '65', SIGNAL_JUDGE_DEFAULT: 'skip' };
    const cfg = parseSignalTraderConfig(env);

    it('no reader / no override / a throwing reader ⇒ exactly the env config', () => {
      expect(withSignalTuning(cfg, undefined)).toBe(cfg);
      expect(withSignalTuning(cfg, DEFAULT_TUNING)).toBe(cfg);
      expect(withSignalTuning(cfg, throwing)).toBe(cfg);
      expect(cfg.judgeMinConfidence).toBe(65);
      expect(cfg.judgeDefault).toBe('skip');
      // Unset env = the code defaults 60 / take, unchanged.
      const d = withSignalTuning(parseSignalTraderConfig({}), DEFAULT_TUNING);
      expect([d.judgeMinConfidence, d.judgeDefault]).toEqual([60, 'take']);
    });

    it('an override wins; out of bounds / non-integer keeps the env value', () => {
      const t = withSignalTuning(cfg, reader({ 'signal.judgeMinConfidence': 55, 'signal.judgeDefaultTake': true }));
      expect([t.judgeMinConfidence, t.judgeDefault]).toEqual([55, 'take']);
      expect(withSignalTuning(cfg, reader({ 'signal.judgeMinConfidence': 90 })).judgeMinConfidence).toBe(65);
      expect(withSignalTuning(cfg, reader({ 'signal.judgeMinConfidence': 55.5 })).judgeMinConfidence).toBe(65);
    });
  });

  describe('exit discipline', () => {
    const base = parseExitDisciplineConfig({ FLOOR_ARM_N: '1.8' });

    it('no reader / no override / a throwing reader ⇒ today\'s values (env floor N, the spike constants)', () => {
      expect(withSessionExitTuning(base, undefined)).toBe(base);
      for (const r of [DEFAULT_TUNING, throwing]) {
        const c = withSessionExitTuning(base, r);
        expect([c.floorArmN, c.floorTrailN, c.spikeBankRiseN, c.spikeBankTrailN]).toEqual([1.8, 2.0, SPIKE_BANK_RISE_N, SPIKE_BANK_TRAIL_N]);
        expect({ ...c, problems: [] }).toMatchObject({ ...base, problems: [] });
      }
    });

    it('reads the session reader on every access (a holder of the injected config sees the session value)', () => {
      const vals: Record<string, TunableValue> = {};
      const c = withSessionExitTuning(base, reader(vals));
      expect(c.floorTrailN).toBe(2.0);
      vals['exit.floorTrailN'] = 2.5;
      vals['exit.spikeBankTrailN'] = 0.75;
      vals['exit.floorArmN'] = 9; // out of bounds ⇒ env
      expect(c.floorTrailN).toBe(2.5);
      expect(c.spikeBankTrailN).toBe(0.75);
      expect(c.floorArmN).toBe(1.8);
      expect({ ...c }.floorTrailN).toBe(2.5);
    });

    it('the cycle spike bank uses the config\'s rise / trail N, the constants when absent', () => {
      const cfg = parseExitDisciplineConfig({});
      const i = { side: 'LONG' as const, entryPrice: 100, ltp: 100, peak: null, nContract: 2, bars: [], now: new Date('2026-11-05T05:00:00Z'), memory: { entry: null, latch: null, prevBest: null, samples: [] }, last: undefined };
      const plain = solveCycleSpike({ ...i, cfg } as never);
      expect(plain.block?.needRiseN).toBe(SPIKE_BANK_RISE_N);
      const tuned = solveCycleSpike({ ...i, cfg: withSessionExitTuning(cfg, reader({ 'exit.spikeBankRiseN': 3 })) } as never);
      expect(tuned.block?.needRiseN).toBe(3);
    });
  });

  describe('intraday carry', () => {
    const cfg = parseCarryConfig({});

    it('no reader / no override / a throwing reader ⇒ INTRADAY_CARRY_DECIDE_BY_MIN (6)', () => {
      expect(withCarryTuning(cfg, undefined)).toBe(cfg);
      expect(withCarryTuning(cfg, DEFAULT_TUNING)).toBe(cfg);
      expect(withCarryTuning(cfg, throwing)).toBe(cfg);
      expect(cfg.decideByMin).toBe(6);
    });

    it('an override wins only inside (safetyMin, windowMin) and 4–9', () => {
      expect(withCarryTuning(cfg, reader({ 'carry.decideByMin': 8 })).decideByMin).toBe(8);
      expect(withCarryTuning(cfg, reader({ 'carry.decideByMin': 10 })).decideByMin).toBe(6);
      const narrow = parseCarryConfig({ INTRADAY_CARRY_WINDOW_MIN: '7' });
      expect(withCarryTuning(narrow, reader({ 'carry.decideByMin': 8 })).decideByMin).toBe(narrow.decideByMin);
    });
  });
});
