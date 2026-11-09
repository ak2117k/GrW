import {
  BATCH_CAP,
  buildImpactUserMessage,
  eligible,
  highImpactTargets,
  impactRank,
  impactRunDue,
  impactSentiment,
  NEWS_IMPACT_PROMPT_VERSION,
  NEWS_IMPACT_SCHEMA,
  NEWS_IMPACT_SYSTEM,
  normaliseTargets,
  pickBatch,
  validateImpactReply,
  type ClusterForImpact,
} from './impact';

const NOW = new Date('2026-10-23T06:00:00Z');
function cl(id: string, o: Partial<ClusterForImpact> = {}): ClusterForImpact {
  return {
    id,
    headline: `Story ${id}`,
    instruments: ['RELIANCE'],
    sectors: [],
    indices: [],
    sources: ['Economic Times'],
    sourceCount: 1,
    firstSeen: new Date(NOW.getTime() - 3_600_000),
    lastSeen: new Date(NOW.getTime() - 1_800_000),
    materialType: 'NEWS',
    material: false,
    boilerplate: false,
    relevance: 0.6,
    reasons: [],
    impactAttempts: 0,
    analysedSourceCount: null,
    ...o,
  };
}

describe('reading results first', () => {
  const NOW_R = new Date('2026-11-07T10:00:00Z');
  const c = (id: string, o: Record<string, unknown>) => ({
    id, headline: id, instruments: ['X'], sectors: [], indices: [], sources: ['ET'], sourceCount: 1, firstSeen: NOW_R, lastSeen: NOW_R,
    materialType: 'NEWS', material: false, boilerplate: false, relevance: 0.4, reasons: [], impactAttempts: 0, analysedSourceCount: null, ...o,
  }) as never;

  it('a results story beats more relevant ordinary news when the batch is full', () => {
    const ordinary = Array.from({ length: 30 }, (_, i) => c(`n${i}`, { relevance: 1 }));
    expect(pickBatch([...ordinary, c('results', { materialType: 'RESULTS', material: true })], NOW_R).map((x) => x.id)).toContain('results');
  });
  it('a story up to 48 hours old can still be read after an outage', () => {
    const old = (h: number) => c('o', { lastSeen: new Date(NOW_R.getTime() - h * 3_600_000) });
    expect(pickBatch([old(47)], NOW_R)).toHaveLength(1);
    expect(pickBatch([old(49)], NOW_R)).toHaveLength(0);
  });
});

describe('batch building', () => {
  it('only relevant, non-boilerplate, fresh clusters; NSE-only must be material', () => {
    expect(eligible(cl('a'), NOW)).toBe(true);
    expect(eligible(cl('b', { boilerplate: true }), NOW)).toBe(false);
    expect(eligible(cl('c', { relevance: 0.2 }), NOW)).toBe(false);
    expect(eligible(cl('d', { sources: ['NSE Announcements'], material: false }), NOW)).toBe(false);
    expect(eligible(cl('e', { sources: ['NSE Announcements'], material: true, materialType: 'RESULTS' }), NOW)).toBe(true);
    expect(eligible(cl('f', { lastSeen: new Date(NOW.getTime() - 49 * 3_600_000) }), NOW)).toBe(false);
  });

  it('once only: an analysed cluster is re-sent only when its coverage doubles; given up after 2 attempts', () => {
    expect(eligible(cl('a', { analysedSourceCount: 2, sourceCount: 3 }), NOW)).toBe(false);
    expect(eligible(cl('a', { analysedSourceCount: 2, sourceCount: 4 }), NOW)).toBe(true);
    expect(eligible(cl('a', { impactAttempts: 2 }), NOW)).toBe(false);
  });

  it('caps at 30, most relevant first', () => {
    const many = Array.from({ length: 45 }, (_, i) => cl(`c${i}`, { relevance: 0.4 + (i % 6) / 10 }));
    const b = pickBatch(many, NOW);
    expect(b).toHaveLength(BATCH_CAP);
    expect(b[0].relevance).toBeGreaterThanOrEqual(b[b.length - 1].relevance);
  });

  it('prompt: headline + ≤ 2 other titles + truncated summary, never a body', () => {
    const long = 'x'.repeat(2000);
    const msg = buildImpactUserMessage([{ ...cl('a'), titles: ['Story a', 't1', 't2', 't3'], summary: long }]);
    expect(msg).toContain('clusterId: a');
    expect(msg).toContain('also: t1');
    expect(msg).toContain('also: t2');
    expect(msg).not.toContain('also: t3');
    expect(msg.length).toBeLessThan(1200);
  });
});

describe('reply validation', () => {
  const good = {
    clusterId: 'a', direction: 'BULL', magnitude: 'HIGH', horizon: 'DAYS',
    affected: { symbols: ['reliance', 'ongc'], sectors: ['Energy'], index: 'NIFTY' }, pricedIn: false, confidence: 0.8, oneLine: 'Big order.',
  };

  it('schema is strict JSON with the agreed fields', () => {
    expect(NEWS_IMPACT_SCHEMA.properties.items.items.required).toEqual(['clusterId', 'direction', 'magnitude', 'horizon', 'affected', 'pricedIn', 'eventRisk', 'confidence', 'oneLine']);
  });

  it('keeps well-formed items for batch ids, once each; upper-cases symbols', () => {
    const out = validateImpactReply({ items: [good, good, { ...good, clusterId: 'zzz' }] }, ['a', 'b']);
    expect(out).toHaveLength(1);
    expect(out[0].affected.symbols).toEqual(['RELIANCE', 'ONGC']);
  });

  it('drops bad enums / index / confidence / missing fields; rescales 0..100 confidence', () => {
    expect(validateImpactReply({ items: [{ ...good, direction: 'UP' }] }, ['a'])).toEqual([]);
    expect(validateImpactReply({ items: [{ ...good, affected: { ...good.affected, index: 'SENSEX' } }] }, ['a'])).toEqual([]);
    expect(validateImpactReply({ items: [{ ...good, confidence: 150 }] }, ['a'])).toEqual([]);
    expect(validateImpactReply({ items: [{ ...good, oneLine: '' }] }, ['a'])).toEqual([]);
    expect(validateImpactReply({ items: [{ ...good, confidence: 70 }] }, ['a'])[0].confidence).toBe(0.7);
    expect(validateImpactReply({ items: [{ ...good, affected: { ...good.affected, index: null } }] }, ['a'])[0].affected.index).toBeNull();
    expect(validateImpactReply('nope', ['a'])).toEqual([]);
  });
});

describe('impact → sentiment, rank, targets, cadence', () => {
  it('maps direction × magnitude × confidence; NEUTRAL is 0; priced-in halves', () => {
    expect(impactSentiment({ direction: 'BULL', magnitude: 'HIGH', confidence: 1, pricedIn: false })).toEqual({ sentiment: 'bullish', score: 0.9 });
    expect(impactSentiment({ direction: 'BEAR', magnitude: 'LOW', confidence: 1, pricedIn: true })).toEqual({ sentiment: 'bearish', score: -0.15 });
    expect(impactSentiment({ direction: 'NEUTRAL', magnitude: 'HIGH', confidence: 1, pricedIn: false })).toEqual({ sentiment: 'neutral', score: 0 });
  });

  it('rank grows with magnitude, relevance and coverage', () => {
    const i = { magnitude: 'HIGH', direction: 'BULL', pricedIn: false, confidence: 0.8 };
    expect(impactRank(i, 1, 4)).toBeGreaterThan(impactRank(i, 1, 1));
    expect(impactRank(i, 1, 1)).toBeGreaterThan(impactRank({ ...i, magnitude: 'LOW' }, 1, 1));
  });

  it('HIGH targets: held symbols + NIFTY/BANKNIFTY; nothing for MED or unheld', () => {
    const aff = { symbols: ['RELIANCE', 'TCS'], sectors: [], index: 'NIFTY' as const };
    expect(highImpactTargets({ magnitude: 'HIGH', affected: aff }, new Set(['TCS']))).toEqual(['TCS', 'NIFTY']);
    expect(highImpactTargets({ magnitude: 'MED', affected: aff }, new Set(['TCS']))).toEqual([]);
    expect(highImpactTargets({ magnitude: 'HIGH', affected: { ...aff, index: null } }, new Set())).toEqual([]);
  });

  it('every tick in the NSE session (09:00–15:45), every 2 h otherwise', () => {
    const last = new Date(NOW.getTime() - 20 * 60_000);
    expect(impactRunDue(NOW, 11 * 60, true, last)).toBe(true);
    expect(impactRunDue(NOW, 18 * 60, true, last)).toBe(false);
    expect(impactRunDue(NOW, 11 * 60, false, last)).toBe(false);
    expect(impactRunDue(NOW, 18 * 60, true, new Date(NOW.getTime() - 2 * 3_600_000))).toBe(true);
    expect(impactRunDue(NOW, 18 * 60, true, null)).toBe(true);
  });
});

describe('prompt v2 (2026-11-02): one direction per target set, crude guidance, recaps', () => {
  const base = {
    clusterId: 'c1', direction: 'BULL' as const, magnitude: 'MED' as const, horizon: 'DAYS' as const,
    affected: { symbols: ['CRUDEOIL'], sectors: [], index: 'NIFTY' as const }, pricedIn: false, confidence: 0.6, oneLine: 'Oil spike pressures equities.',
  };

  it('the system prompt carries the version, the crude-vs-index rule and the oil-direction guidance', () => {
    expect(NEWS_IMPACT_PROMPT_VERSION).toBe('v3'); // v3 (2026-11-04) keeps every v2 rule; adds eventRisk
    expect(NEWS_IMPACT_SYSTEM).toMatch(/TRUE FOR EVERY TARGET/);
    expect(NEWS_IMPACT_SYSTEM).toMatch(/ceasefire[^\n]*CRUDEOIL BEAR/);
    expect(NEWS_IMPACT_SYSTEM).toMatch(/Hormuz[^\n]*CRUDEOIL BULL/);
    expect(NEWS_IMPACT_SYSTEM).toMatch(/top gainers and losers/);
  });

  it('a directional reply naming a commodity AND an index keeps neither (stocks stay)', () => {
    // Prod 28 Oct: "Indian shares set for lower open as oil rise weighs" → BULL [CRUDEOIL] + NIFTY (crude's direction).
    expect(normaliseTargets(base).affected).toEqual({ symbols: [], sectors: [], index: null });
    expect(normaliseTargets({ ...base, affected: { symbols: ['CRUDEOIL', 'ONGC'], sectors: [], index: 'NIFTY' } }).affected).toEqual({ symbols: ['ONGC'], sectors: [], index: null });
    // NEUTRAL: nothing contradicts, kept.
    expect(normaliseTargets({ ...base, direction: 'NEUTRAL' }).affected.index).toBe('NIFTY');
  });

  it('commodity aliases / minis → the MCX benchmark; untouched items are returned as-is', () => {
    expect(normaliseTargets({ ...base, affected: { symbols: ['BRENT', 'CRUDEOILM'], sectors: [], index: null } }).affected.symbols).toEqual(['CRUDEOIL']);
    const plain = { ...base, affected: { symbols: ['TCS'], sectors: [], index: 'NIFTY' as const } };
    expect(normaliseTargets(plain)).toBe(plain);
  });

  it('a held CRUDEOILM position is a HIGH target of a CRUDEOIL story', () => {
    expect(highImpactTargets({ magnitude: 'HIGH', affected: { symbols: ['CRUDEOIL'], sectors: [], index: null } }, new Set(['CRUDEOILM']))).toEqual(['CRUDEOIL']);
  });

  it('a recap cluster is flagged to the model in the batch message', () => {
    const msg = buildImpactUserMessage([cl('w1', { headline: 'Sensex, Nifty fall as oil tops $116; midcaps crash' }), cl('n1', { headline: 'L&T wins ₹5,000 crore metro order' })]);
    const [w, n] = msg.split('clusterId: ').slice(1);
    expect(w).toMatch(/note: wrap headline \(a recap\) — answer NEUTRAL, LOW, pricedIn true/);
    expect(n).not.toMatch(/note:/);
  });
});

describe('prompt v3 (2026-11-04): EVENT_RISK — big move expected, direction unknown', () => {
  const good = {
    clusterId: 'e1', direction: 'NEUTRAL', magnitude: 'LOW', horizon: 'INTRADAY',
    affected: { symbols: ['GOLD', 'SILVER'], sectors: [], index: 'NIFTY' }, pricedIn: false, confidence: 0.6, oneLine: 'US midterm results due; big move either way.',
  };

  it('the prompt names the rule: scheduled / binary / political-macro outcomes are EVENT_RISK even when NEUTRAL', () => {
    expect(NEWS_IMPACT_SYSTEM).toMatch(/eventRisk: true when the story is about a SCHEDULED, BINARY or POLITICAL-MACRO outcome/);
    expect(NEWS_IMPACT_SYSTEM).toMatch(/election/);
    expect(NEWS_IMPACT_SYSTEM).toMatch(/even when the direction is NEUTRAL/);
    expect(NEWS_IMPACT_SCHEMA.properties.items.items.properties.eventRisk).toEqual({ type: 'boolean' });
  });

  it('parses eventRisk true / false; missing or non-boolean → false (the item is kept)', () => {
    expect(validateImpactReply({ items: [{ ...good, eventRisk: true }] }, ['e1'])[0].eventRisk).toBe(true);
    expect(validateImpactReply({ items: [{ ...good, eventRisk: false }] }, ['e1'])[0].eventRisk).toBe(false);
    expect(validateImpactReply({ items: [good] }, ['e1'])[0].eventRisk).toBe(false);
    expect(validateImpactReply({ items: [{ ...good, eventRisk: 'yes' }] }, ['e1'])[0].eventRisk).toBe(false);
  });

  it('a NEUTRAL event-risk story keeps its commodity and index targets', () => {
    const [item] = validateImpactReply({ items: [{ ...good, eventRisk: true }] }, ['e1']);
    expect(normaliseTargets(item).affected).toEqual({ symbols: ['GOLD', 'SILVER'], sectors: [], index: 'NIFTY' });
  });
});
