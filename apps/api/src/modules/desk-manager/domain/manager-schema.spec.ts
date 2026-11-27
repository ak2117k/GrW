import { MANAGER_REPLY_SCHEMA, parseManagerReply } from './manager-schema';

const OPEN = {
  action: 'OPEN',
  underlying: 'BSE',
  side: 'BUY_CE',
  strikePolicy: 'ATM',
  expiryPolicy: 'NEAREST',
  entry: { type: 'ZONE', low: 2840, high: 2850, triggerAbove: null, triggerBelow: null, validMin: 30 },
  stop: { underlying: 2820 },
  targets: { underlying: [2900, 2940] },
  proposalRef: null,
  confidence: 'medium',
  reason: 'reading CALL confirmed, holding above VWAP',
  evidence: ['ltp 2861', 'vwap 2846'],
};
const EXIT = { action: 'EXIT', trackerId: 't1', reason: 'thesis broken', evidence: ['underlying 2810 < invalidation 2820'] };

describe('parseManagerReply', () => {
  it('malformed reply acts on nothing (non-JSON text, a non-object, missing decisions)', () => {
    expect(parseManagerReply('I think we should buy BSE').ok).toBe(false);
    expect(parseManagerReply('{"summary": "x", "decisions": [').ok).toBe(false);
    expect(parseManagerReply(null).ok).toBe(false);
    expect(parseManagerReply([]).ok).toBe(false);
    expect(parseManagerReply({ summary: 'x' }).ok).toBe(false);
    expect(parseManagerReply({ decisions: [] }).ok).toBe(false);
  });

  it('a reply wrapped in a line of prose still parses; a broken object inside prose does not', () => {
    const inner = '{"summary":"quiet","decisions":[{"action":"NO_ACTION","proposalRef":null,"reason":"no edge","evidence":["ltp 1 (x)"]}]}';
    const r = parseManagerReply(`Here is the desk decision:\n${inner}\nThat is all.`);
    expect(r.ok).toBe(true);
    expect(r.ok && r.reply.decisions[0].action).toBe('NO_ACTION');
    expect(parseManagerReply('Decision: {"summary": "x", "decisions": [ } done').ok).toBe(false);
    expect(parseManagerReply('{"summary":"x","decisions":[{"action":"FLY","reason":"r","evidence":["e"]}]} ok').ok).toBe(false);
  });

  it('unknown action rejected (and one bad decision rejects the whole reply)', () => {
    const r = parseManagerReply({ summary: 's', decisions: [EXIT, { action: 'SELL_EVERYTHING', reason: 'r', evidence: ['1'] }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/decision 1.*unknown action SELL_EVERYTHING/);
  });

  it('valid reply parsed (object or JSON text with a ```json fence); nulls become absent', () => {
    const reply = { summary: 'one exit, one open', decisions: [EXIT, OPEN, { action: 'NO_ACTION', reason: 'quiet', evidence: [] }] };
    for (const raw of [reply, JSON.stringify(reply), '```json\n' + JSON.stringify(reply) + '\n```']) {
      const r = parseManagerReply(raw);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.reply.summary).toBe('one exit, one open');
      expect(r.reply.decisions).toHaveLength(3);
      const o = r.reply.decisions[1];
      expect(o).toMatchObject({ action: 'OPEN', underlying: 'BSE', entry: { type: 'ZONE', low: 2840, high: 2850, validMin: 30 } });
      if (o.action === 'OPEN') {
        expect('triggerAbove' in o.entry).toBe(false);
        expect('proposalRef' in o).toBe(false);
      }
    }
  });

  it('rejects a decision missing its fields or with a non-string evidence item', () => {
    expect(parseManagerReply({ summary: 's', decisions: [{ action: 'EXIT', reason: 'r', evidence: ['x'] }] }).ok).toBe(false);
    expect(parseManagerReply({ summary: 's', decisions: [{ ...EXIT, evidence: [12] }] }).ok).toBe(false);
    expect(parseManagerReply({ summary: 's', decisions: [{ ...EXIT, reason: ' ' }] }).ok).toBe(false);
    expect(parseManagerReply({ summary: 's', decisions: [{ ...OPEN, side: 'SELL_CE' }] }).ok).toBe(false);
    expect(parseManagerReply({ summary: 's', decisions: [{ ...OPEN, stop: { underlying: 'low' } }] }).ok).toBe(false);
    expect(parseManagerReply({ summary: 's', decisions: [{ ...OPEN, targets: { underlying: [] } }] }).ok).toBe(false);
    expect(parseManagerReply({ summary: 's', decisions: [{ action: 'TIGHTEN', trackerId: 't1', underlyingStop: null, reason: 'r', evidence: ['1'] }] }).ok).toBe(false);
    expect(parseManagerReply({ summary: 's', decisions: [{ action: 'PAUSE_ENTRIES', scope: 'all', minutes: '30', reason: 'r', evidence: ['1'] }] }).ok).toBe(false);
  });

  it('accepts a numeric strike policy and every other action shape', () => {
    const r = parseManagerReply({
      summary: 's',
      decisions: [
        { ...OPEN, strikePolicy: 2850 },
        { action: 'BOOK', trackerId: 't2', reason: 'r', evidence: ['1'] },
        { action: 'TIGHTEN', trackerId: 't1', underlyingStop: 2830, reason: 'r', evidence: ['1'] },
        { action: 'PAUSE_ENTRIES', scope: 'NIFTY', minutes: 30, reason: 'r', evidence: ['1'] },
        { action: 'RESUME', reason: 'r', evidence: ['1'] },
        { action: 'WATCH', underlying: 'NIFTY', note: 'n', recheckMin: 6, reason: 'r', evidence: ['1'] },
        { action: 'FLAG_DATA_HOLE', what: 'chain', impact: 'no walls', reason: 'r', evidence: ['1'] },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it('NO_ACTION keeps the declined proposalRef; null or absent means none; a non-string is rejected', () => {
    const r = parseManagerReply({ summary: 's', decisions: [{ action: 'NO_ACTION', proposalRef: 'reading:42', reason: 'stale', evidence: ['ltp 1'] }, { action: 'NO_ACTION', proposalRef: null, reason: 'quiet', evidence: [] }] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.reply.decisions[0]).toEqual({ action: 'NO_ACTION', proposalRef: 'reading:42', reason: 'stale', evidence: ['ltp 1'] });
      expect('proposalRef' in r.reply.decisions[1]).toBe(false);
    }
    expect(parseManagerReply({ summary: 's', decisions: [{ action: 'NO_ACTION', proposalRef: 7, reason: 'r', evidence: [] }] }).ok).toBe(false);
  });

  it('the schema lists every action', () => {
    const actions = (MANAGER_REPLY_SCHEMA.properties.decisions.items.anyOf as unknown as Array<{ properties: { action: { enum: string[] } } }>).flatMap((s) => s.properties.action.enum);
    expect(actions.sort()).toEqual(['BOOK', 'EXIT', 'FLAG_DATA_HOLE', 'NO_ACTION', 'OPEN', 'PAUSE_ENTRIES', 'RESUME', 'TIGHTEN', 'WATCH']);
  });
});
