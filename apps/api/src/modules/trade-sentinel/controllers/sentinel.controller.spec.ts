import {
  DEFAULT_VERDICT_LIMIT,
  MAX_VERDICT_LIMIT,
  SentinelController,
  parseLimit,
} from './sentinel.controller';

const row = (over: Record<string, unknown> = {}) =>
  ({
    id: 'v1',
    trackerId: 't1',
    symbol: 'INFY-EQ',
    verdict: 'HOLD',
    confidence: 'high',
    thesisStatus: 'INTACT',
    recoveryAvailable: true,
    reason: 'ok',
    evidence: ['money.netPnl'],
    invalidationPoint: null,
    triggeredBy: ['heartbeat'],
    netPnl: 10,
    greenFloor: null,
    createdAt: new Date('2026-08-14T10:00:00Z'),
    ...over,
  }) as never;

function make() {
  const listForUser = jest.fn().mockResolvedValue([]);
  const correct = jest.fn().mockResolvedValue({ source: 'USER' });
  const ctrl = new SentinelController({ listForUser } as never, { correct } as never);
  return { ctrl, listForUser, correct };
}

describe('SentinelController — verdicts', () => {
  it('serves the calling user only, and dates as ISO strings', async () => {
    const t = make();
    t.listForUser.mockResolvedValue([row()]);

    const result = await t.ctrl.list('u1', undefined);

    expect(t.listForUser).toHaveBeenCalledWith('u1', DEFAULT_VERDICT_LIMIT);
    expect(result[0].createdAt).toBe('2026-08-14T10:00:00.000Z');
    expect(result[0].evidence).toEqual(['money.netPnl']);
  });

  it('coerces the Json columns rather than trusting them', async () => {
    // `evidence` and `triggeredBy` are jsonb: what comes back is whatever was
    // written. A number reaching a field the UI renders as text is a runtime
    // failure in the browser, not a type error here.
    const t = make();
    t.listForUser.mockResolvedValue([
      row({ evidence: [1, 'money.netPnl', null], triggeredBy: 'heartbeat' }),
    ]);

    const [dto] = await t.ctrl.list('u1', undefined);

    expect(dto.evidence).toEqual(['money.netPnl']);
    expect(dto.triggeredBy).toEqual([]);
  });

  it('clamps the limit instead of handing Prisma whatever arrived', async () => {
    const t = make();
    await t.ctrl.list('u1', '5');
    expect(t.listForUser).toHaveBeenLastCalledWith('u1', 5);

    await t.ctrl.list('u1', '99999');
    expect(t.listForUser).toHaveBeenLastCalledWith('u1', MAX_VERDICT_LIMIT);
  });
});

describe('parseLimit', () => {
  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['not a number', 'abc'],
    // A negative `take` makes Prisma read BACKWARDS rather than error.
    ['negative', '-10'],
    ['zero', '0'],
  ])('falls back to the default for %s', (_label, raw) => {
    expect(parseLimit(raw)).toBe(DEFAULT_VERDICT_LIMIT);
  });

  it('takes a valid limit and caps an oversized one', () => {
    expect(parseLimit('5')).toBe(5);
    expect(parseLimit('200')).toBe(MAX_VERDICT_LIMIT);
    expect(parseLimit('201')).toBe(MAX_VERDICT_LIMIT);
  });

  it('floors a fractional limit — Prisma will not take 2.5', () => {
    expect(parseLimit('2.9')).toBe(2);
  });
});

describe('SentinelController — thesis correction', () => {
  it('routes the correction with the CALLER as the tenant', async () => {
    const t = make();
    await t.ctrl.correctThesis('u1', 't1', { reason: 'momentum breakout' } as never);
    // The userId is not optional decoration: `overrideByUser` scopes the write
    // with it, and without it `trackerId` alone is an IDOR on the row every
    // later judgement is measured against.
    expect(t.correct).toHaveBeenCalledWith('t1', 'u1', {
      reason: 'momentum breakout',
      levelPrice: undefined,
      targetPrice: undefined,
      invalidation: undefined,
    });
  });

  it('NEVER forwards a direction, even when one is in the body', async () => {
    const t = make();
    // The global ValidationPipe strips it first — this proves the controller
    // does not depend on that. A thesis direction opposing the broker's real
    // side inverts every later "has it turned?" read.
    await t.ctrl.correctThesis('u1', 't1', {
      reason: 'faded the supply shelf',
      direction: 'SHORT',
    } as never);

    const patch = t.correct.mock.calls[0][2];
    expect(patch).not.toHaveProperty('direction');
    expect(Object.keys(patch)).toEqual([
      'reason',
      'levelPrice',
      'targetPrice',
      'invalidation',
    ]);
  });

  it('passes the prices through, so a correction is not silently a no-op', async () => {
    const t = make();
    await t.ctrl.correctThesis('u1', 't1', {
      levelPrice: 1450,
      targetPrice: 1520,
      invalidation: 1425,
    } as never);
    expect(t.correct.mock.calls[0][2]).toMatchObject({
      levelPrice: 1450,
      targetPrice: 1520,
      invalidation: 1425,
    });
  });
});

describe('SentinelController — shadow mode', () => {
  it('exposes no route through which a position could be closed', () => {
    const routes = Object.getOwnPropertyNames(SentinelController.prototype);
    for (const name of routes) {
      expect(name).not.toMatch(/exit|close|square|execute|order|place|cancel/i);
    }
    // Positive assertion too, so a rename that empties the prototype cannot
    // make this pass vacuously.
    expect(routes).toEqual(expect.arrayContaining(['list', 'correctThesis']));
  });

  it('injects nothing that could place an order', () => {
    const injected: unknown[] =
      (Reflect as { getMetadata?: (k: string, t: unknown) => unknown[] }).getMetadata?.(
        'design:paramtypes',
        SentinelController,
      ) ?? [];
    expect(injected).toHaveLength(2);
    for (const dep of injected) {
      const name = (dep as { name: string }).name;
      expect(name).not.toMatch(/execution|order|broker|trade-?engine|auto-?trade/i);
      for (const method of Object.getOwnPropertyNames((dep as { prototype: object }).prototype)) {
        expect(method).not.toMatch(/^(execute|placeOrder|squareOff|cancelOrder|modifyOrder)$/i);
      }
    }
  });
});
