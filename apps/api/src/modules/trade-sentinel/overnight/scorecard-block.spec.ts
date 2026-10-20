import type { FactorName, FactorScore, Scorecard } from '../../overnight-scorecard/scorecard.types';
import { SCORECARD_BLOCK_MAX_CHARS, SCORECARD_BLOCK_SOURCE, scorecardBlock, scorecardBrief } from './scorecard-block';
import { NULL_SCORECARD_PROVIDER, scorecardFlagOn } from '../ports/scorecard.port';

const NAMES: FactorName[] = ['oi', 'fii_dii', 'vix', 'expiry', 'news', 'indicators', 'mood'];

const factor = (name: FactorName, over: Partial<FactorScore> = {}): FactorScore => ({
  name,
  points: 1,
  value: `${name} reading`,
  reason: `${name} reason`,
  available: true,
  ...over,
});

const card = (factors: FactorScore[], over: Partial<Scorecard> = {}): Scorecard => ({
  userId: 'u1',
  symbol: 'RELIANCE28OCT261400CE',
  exchange: 'NFO',
  underlying: 'RELIANCE',
  side: 'BULLISH',
  window: 'OVERNIGHT',
  computedAt: '2026-10-20T10:10:00.000Z',
  factors,
  total: factors.reduce((s, f) => s + f.points, 0),
  band: 'SUPPORTS',
  ...over,
});

describe('scorecardBrief / scorecardBlock — the compact overnight.scorecard block', () => {
  it('writes each factor as name:points value, signs positives, and n/a for a missing factor', () => {
    const b = scorecardBrief(
      card([
        factor('oi', { points: 2, value: 'PCR 2.1 (5d med 1.3)' }),
        factor('vix', { points: -1, value: '14.2 vs 20d 12.0' }),
        factor('mood', { points: 0, value: 'QUIET' }),
        factor('news', { points: 0, value: 'ignored', available: false }),
      ]),
    );
    expect(b.factors).toBe('oi:+2 PCR 2.1 (5d med 1.3); vix:-1 14.2 vs 20d 12.0; mood:0 QUIET; news:n/a');
    expect(b).toEqual(expect.objectContaining({ side: 'BULLISH', total: 1, band: 'SUPPORTS', window: 'OVERNIGHT' }));
  });

  it('is a present block dated to computedAt', () => {
    const sc = card([factor('oi')]);
    expect(scorecardBlock(sc)).toEqual({ available: true, value: scorecardBrief(sc), source: SCORECARD_BLOCK_SOURCE, at: sc.computedAt });
  });

  it(`stays within ${SCORECARD_BLOCK_MAX_CHARS} chars: shortens values first, keeps every factor's name and points`, () => {
    const long = 'x'.repeat(500);
    const b = scorecardBrief(card(NAMES.map((n, i) => factor(n, { points: ((i % 5) - 2) as FactorScore['points'], value: long }))));
    expect(JSON.stringify(b).length).toBeLessThanOrEqual(SCORECARD_BLOCK_MAX_CHARS);
    for (const n of NAMES) expect(b.factors).toMatch(new RegExp(`(^|; )${n}:[-+]?\\d`));
  });

  it('a short card is left as written (no clipping)', () => {
    const b = scorecardBrief(card(NAMES.map((n) => factor(n))));
    expect(b.factors).not.toContain('…');
    expect(JSON.stringify(b).length).toBeLessThanOrEqual(SCORECARD_BLOCK_MAX_CHARS);
  });

  it('still fits with an absurd factor list (the line itself is cut)', () => {
    const many = Array.from({ length: 80 }, (_, i) => factor(NAMES[i % NAMES.length], { value: 'v'.repeat(80) }));
    const b = scorecardBrief(card(many));
    expect(JSON.stringify(b).length).toBeLessThanOrEqual(SCORECARD_BLOCK_MAX_CHARS);
    expect(b.factors.endsWith('…')).toBe(true);
  });
});

describe('the scorecard port', () => {
  it('SENTINEL_SCORECARD is on only for "on" (any case, trimmed)', () => {
    for (const v of ['on', 'ON', ' On ']) expect(scorecardFlagOn(v)).toBe(true);
    for (const v of [undefined, null, '', 'off', 'true', '1', 'observe']) expect(scorecardFlagOn(v)).toBe(false);
  });

  it('the default provider never has a scorecard', async () => {
    await expect(NULL_SCORECARD_PROVIDER.latest('u1', 't1')).resolves.toBeNull();
  });
});
