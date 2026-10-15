// apps/api/src/modules/sentinel-executor/domain/trigger-rules.spec.ts
import { adverseOp, contractKindOf, validateTrigger, type TriggerLevel } from './trigger-rules';

const CFG = { maxDistancePct: { UNDERLYING: 10, PREMIUM: 60 }, tightenOnly: true };
const at = (price: number, ageMs = 1000) => ({ price, ageMs });
const lvl = (instrument: 'UNDERLYING' | 'PREMIUM', op: 'BELOW' | 'ABOVE', price: number): TriggerLevel => ({ instrument, op, price });
const run = (o: Partial<Parameters<typeof validateTrigger>[0]>) =>
  validateTrigger({ proposal: lvl('UNDERLYING', 'BELOW', 8930), qty: 100, kind: 'CE', current: at(8951), armed: null, cfg: CFG, ...o });

describe('contractKindOf', () => {
  it.each([
    ['CRUDEOIL19NOV268950CE', 'CE'], ['NIFTY28OCT2624000PE', 'PE'], ['CRUDEOIL19NOV26FUT', 'FUT'],
    ['RELIANCE', null], ['RELIANCE-EQ', null], ['nifty28oct2624000pe', 'PE'],
  ])('%s → %s', (s, k) => expect(contractKindOf(s)).toBe(k));
});

describe('adverseOp — the cross that HURTS the position (ruling R4, D5)', () => {
  it.each([
    ['PREMIUM', 100, 'CE', 'BELOW'], ['PREMIUM', -100, 'CE', 'ABOVE'],
    ['PREMIUM', 100, 'PE', 'BELOW'], ['PREMIUM', -100, 'PE', 'ABOVE'],
    ['UNDERLYING', 100, 'CE', 'BELOW'], ['UNDERLYING', -100, 'CE', 'ABOVE'],
    ['UNDERLYING', 100, 'PE', 'ABOVE'], ['UNDERLYING', -100, 'PE', 'BELOW'],
    ['UNDERLYING', 100, 'FUT', 'BELOW'], ['UNDERLYING', -100, 'FUT', 'ABOVE'],
    ['UNDERLYING', 100, null, null], ['PREMIUM', 0, 'CE', null],
  ] as const)('%s qty %d %s → %s', (instrument, qty, kind, op) => expect(adverseOp(instrument, qty, kind)).toBe(op));
});

describe('validateTrigger', () => {
  it('a protective, fresh, in-range level arms', () => expect(run({})).toEqual({ ok: true }));

  it('a long PUT protects with UNDERLYING ABOVE; BELOW would be a profit-take (NOT_PROTECTIVE)', () => {
    expect(run({ kind: 'PE', proposal: lvl('UNDERLYING', 'ABOVE', 8970) })).toEqual({ ok: true });
    expect(run({ kind: 'PE', proposal: lvl('UNDERLYING', 'BELOW', 8930) })).toEqual({ ok: false, reason: 'NOT_PROTECTIVE' });
  });

  it('a long with ABOVE on PREMIUM is a profit-take (D5) → NOT_PROTECTIVE', () => {
    expect(run({ proposal: lvl('PREMIUM', 'ABOVE', 250), current: at(212) })).toEqual({ ok: false, reason: 'NOT_PROTECTIVE' });
  });

  it('unknown contract kind on UNDERLYING → UNKNOWN_CONTRACT_KIND', () => {
    expect(run({ kind: null })).toEqual({ ok: false, reason: 'UNKNOWN_CONTRACT_KIND' });
  });

  it.each([
    ['no price', null],
    ['a 16 s old price', at(8951, 16_000)],
    ['a zero price', at(0)],
  ])('%s → NO_FRESH_PRICE', (_l, current) => {
    expect(run({ current })).toEqual({ ok: false, reason: 'NO_FRESH_PRICE' });
  });

  it('a level already crossed (or equal to current) → ALREADY_CROSSED', () => {
    expect(run({ current: at(8925) })).toEqual({ ok: false, reason: 'ALREADY_CROSSED' });
    expect(run({ current: at(8930) })).toEqual({ ok: false, reason: 'ALREADY_CROSSED' });
  });

  it('distance bounds per instrument → TOO_FAR with the numbers', () => {
    const r = run({ proposal: lvl('UNDERLYING', 'BELOW', 7900), current: at(8951) });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/^TOO_FAR \(11\.7\d?% > 10%\)$/);
    expect(run({ proposal: lvl('PREMIUM', 'BELOW', 90), current: at(212) })).toEqual({ ok: true }); // 57.5 %
  });

  it('a non-finite or non-positive level → BAD_PRICE', () => {
    expect(run({ proposal: lvl('UNDERLYING', 'BELOW', Number.NaN) })).toEqual({ ok: false, reason: 'BAD_PRICE' });
  });

  describe('tighten-only (D4, ruling R5)', () => {
    const armed = lvl('UNDERLYING', 'BELOW', 8930);
    it('a BELOW level may rise (tighten) or stay (renewal)', () => {
      expect(run({ armed, proposal: lvl('UNDERLYING', 'BELOW', 8940) })).toEqual({ ok: true });
      expect(run({ armed, proposal: lvl('UNDERLYING', 'BELOW', 8930) })).toEqual({ ok: true });
    });
    it('a BELOW level may never fall → LOOSENS', () => {
      expect(run({ armed, proposal: lvl('UNDERLYING', 'BELOW', 8900) })).toEqual({ ok: false, reason: 'LOOSENS' });
    });
    it('an ABOVE level may only fall', () => {
      const a = lvl('UNDERLYING', 'ABOVE', 8990);
      expect(run({ kind: 'PE', armed: a, proposal: lvl('UNDERLYING', 'ABOVE', 8980) })).toEqual({ ok: true });
      expect(run({ kind: 'PE', armed: a, proposal: lvl('UNDERLYING', 'ABOVE', 9000) })).toEqual({ ok: false, reason: 'LOOSENS' });
    });
    it('switching instrument while one is armed → INSTRUMENT_SWITCH', () => {
      expect(run({ armed, proposal: lvl('PREMIUM', 'BELOW', 180), current: at(212) })).toEqual({ ok: false, reason: 'INSTRUMENT_SWITCH' });
    });
    it('with tighten-only off, both are allowed', () => {
      const cfg = { ...CFG, tightenOnly: false };
      expect(run({ cfg, armed, proposal: lvl('UNDERLYING', 'BELOW', 8900) })).toEqual({ ok: true });
      expect(run({ cfg, armed, proposal: lvl('PREMIUM', 'BELOW', 180), current: at(212) })).toEqual({ ok: true });
    });
  });
});
