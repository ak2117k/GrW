import {
  NEWS_SINCE_CLOSE_CAP,
  classifyBuildUp,
  cueBlock,
  newsSinceCloseBlock,
  oiAnalysisBlock,
  overnightDecayBlock,
  parseOptionSymbol,
  preOpenPriceBlock,
  type NewsEvidence,
  type RawOiAnalysis,
} from './overnight-evidence';

const ist = (ymd: string, hhmm: string) => new Date(`${ymd}T${hhmm}:00+05:30`);

describe('parseOptionSymbol', () => {
  it('reads strike and type off NSE, BSE and MCX option tradingsymbols', () => {
    expect(parseOptionSymbol('NIFTY13OCT2625000CE')).toEqual({ underlying: 'NIFTY', strike: 25000, optionType: 'CE' });
    expect(parseOptionSymbol('SENSEX15OCT2682000PE')).toEqual({ underlying: 'SENSEX', strike: 82000, optionType: 'PE' });
    expect(parseOptionSymbol('CRUDEOIL16OCT265600CE')).toEqual({ underlying: 'CRUDEOIL', strike: 5600, optionType: 'CE' });
    expect(parseOptionSymbol('KEI29SEP265800CE')).toEqual({ underlying: 'KEI', strike: 5800, optionType: 'CE' });
  });

  it('is null for a future, a cash symbol or anything unreadable', () => {
    expect(parseOptionSymbol('BANKNIFTY27OCT26FUT')).toBeNull();
    expect(parseOptionSymbol('RELIANCE-EQ')).toBeNull();
    expect(parseOptionSymbol('')).toBeNull();
  });
});

describe('classifyBuildUp — price change against OI change', () => {
  it('price up, OI up is a long build-up', () => {
    expect(classifyBuildUp(12, 5000)).toBe('LONG_BUILD_UP');
  });
  it('price down, OI up is a short build-up', () => {
    expect(classifyBuildUp(-12, 5000)).toBe('SHORT_BUILD_UP');
  });
  it('price up, OI down is short covering', () => {
    expect(classifyBuildUp(12, -5000)).toBe('SHORT_COVERING');
  });
  it('price down, OI down is long unwinding', () => {
    expect(classifyBuildUp(-12, -5000)).toBe('LONG_UNWINDING');
  });
  it('is null — not a quadrant — when either side is flat or not a finite reading', () => {
    expect(classifyBuildUp(0, 5000)).toBeNull();
    expect(classifyBuildUp(12, 0)).toBeNull();
    expect(classifyBuildUp(Number.NaN, 5000)).toBeNull();
    expect(classifyBuildUp(12, null)).toBeNull();
  });
});

describe('overnightDecayBlock — one night of theta, in rupees for this position', () => {
  const base = {
    segment: 'OPT' as const,
    side: 'LONG' as const,
    qty: 75,
    premium: 120,
    spot: 25000,
    strike: 25000,
    optionType: 'CE' as const,
    expiry: '2026-10-13',
    now: ist('2026-10-12', '15:45'),
    nextOpen: ist('2026-10-13', '09:15'),
  };

  it('uses the chain’s theta when there is one, scaled to the hours until the next open', () => {
    const block = overnightDecayBlock({ ...base, chainTheta: -24 });
    expect(block.available).toBe(true);
    if (!block.available) return;
    // 17.5 hours = 0.729 days; -24/day x 0.729 x 75 units, against a LONG.
    expect(block.value.nightDays).toBeCloseTo(17.5 / 24, 3);
    expect(block.value.thetaPerUnitPerDay).toBe(-24);
    expect(block.value.rupeesForPosition).toBeCloseTo(-24 * (17.5 / 24) * 75, 0);
    expect(block.value.method).toMatch(/options-chain/);
  });

  it('a SHORT option collects the decay — the sign flips with the side', () => {
    const block = overnightDecayBlock({ ...base, side: 'SHORT', chainTheta: -24 });
    expect(block.available && block.value.rupeesForPosition).toBeGreaterThan(0);
  });

  it('falls back to a clearly labelled Black–Scholes ESTIMATE when the chain has no theta', () => {
    const block = overnightDecayBlock({ ...base, chainTheta: null });
    expect(block.available).toBe(true);
    if (!block.available) return;
    expect(block.value.method).toMatch(/ESTIMATE/);
    expect(block.value.thetaPerUnitPerDay).toBeLessThan(0);
    expect(block.value.rupeesForPosition).toBeLessThan(0);
  });

  it('a long option can never decay by more than its whole premium', () => {
    const block = overnightDecayBlock({ ...base, premium: 2, chainTheta: -500 });
    expect(block.available && block.value.rupeesForPosition).toBeGreaterThanOrEqual(-2 * 75);
  });

  it('is absent for a future, with the reason, and never a zero', () => {
    const block = overnightDecayBlock({ ...base, segment: 'FUT', chainTheta: null });
    expect(block).toEqual({ available: false, reason: expect.stringMatching(/future/i) });
  });

  it('is absent when neither the chain nor an estimate can produce a theta', () => {
    const block = overnightDecayBlock({ ...base, spot: null, chainTheta: null });
    expect(block.available).toBe(false);
  });
});

describe('preOpenPriceBlock — never invents a price', () => {
  it('at 08:50 says plainly there is no NSE pre-open price yet', () => {
    const block = preOpenPriceBlock('NFO', ist('2026-10-12', '08:50'), {
      price: 101,
      at: ist('2026-10-09', '15:29').toISOString(),
    });
    expect(block.available).toBe(false);
    if (block.available) return;
    expect(block.reason).toMatch(/09:00.09:08/);
    expect(block.reason).toMatch(/previous session/i);
  });

  it('at 08:50 says MCX has not opened yet', () => {
    const block = preOpenPriceBlock('MCX', ist('2026-10-12', '08:50'), null);
    expect(block.available).toBe(false);
    if (block.available) return;
    expect(block.reason).toMatch(/MCX opens at 09:00/);
  });

  it('uses a price only when it was printed today, at or after the pre-open started', () => {
    const block = preOpenPriceBlock('NFO', ist('2026-10-12', '09:05'), {
      price: 101.5,
      at: ist('2026-10-12', '09:04').toISOString(),
    });
    expect(block).toEqual({
      available: true,
      value: 101.5,
      source: expect.stringMatching(/pre-open/),
      at: ist('2026-10-12', '09:04').toISOString(),
    });
  });

  it('refuses a stale price even after the pre-open has begun', () => {
    const block = preOpenPriceBlock('NFO', ist('2026-10-12', '09:05'), {
      price: 101,
      at: ist('2026-10-09', '15:29').toISOString(),
    });
    expect(block.available).toBe(false);
  });
});

describe('newsSinceCloseBlock — symbol, sector, index and macro since the last close', () => {
  const since = ist('2026-10-12', '15:30');
  const now = ist('2026-10-12', '15:45');
  const item = (title: string, hhmm: string, scope: 'symbol' | 'sector' | 'index' | 'macro', over = {}) => ({
    title,
    source: 'LiveMint',
    publishedAt: ist('2026-10-12', hhmm).toISOString(),
    sentiment: 'bearish' as string | null,
    url: `https://x/${encodeURIComponent(title)}`,
    scope,
    ...over,
  });

  it('keeps only items since the close, deduped, newest first, with headline/source/time/sentiment', () => {
    const evidence: NewsEvidence = {
      lastFetchAt: ist('2026-10-12', '15:40').toISOString(),
      items: [
        item('Old news', '14:00', 'symbol'),
        item('Nifty slides on US cues', '15:35', 'index'),
        item('Nifty slides on US cues', '15:35', 'macro'),
        item('Reliance wins order', '15:41', 'symbol', { sentiment: null }),
      ],
    };
    const block = newsSinceCloseBlock(evidence, since, now);
    expect(block.available).toBe(true);
    if (!block.available) return;
    const v = block.value as { items: Array<Record<string, unknown>>; stale: boolean };
    expect(v.items.map((i) => i.title)).toEqual(['Reliance wins order', 'Nifty slides on US cues']);
    // The first scope that surfaced a duplicate wins.
    expect(v.items[1].scope).toBe('index');
    expect(v.items[0]).toEqual(
      expect.objectContaining({ source: 'LiveMint', sentiment: null, publishedAt: expect.any(String) }),
    );
    expect(v.stale).toBe(false);
  });

  it('caps the list at a sensible N', () => {
    const items = Array.from({ length: NEWS_SINCE_CLOSE_CAP + 5 }, (_, i) =>
      item(`headline ${i}`, `15:${String(31 + (i % 14)).padStart(2, '0')}`, 'macro'),
    );
    const block = newsSinceCloseBlock({ lastFetchAt: now.toISOString(), items }, since, now);
    expect(block.available && (block.value as { items: unknown[] }).items).toHaveLength(NEWS_SINCE_CLOSE_CAP);
  });

  it('says the store is STALE when nothing has been fetched since the close', () => {
    const block = newsSinceCloseBlock(
      { lastFetchAt: ist('2026-10-12', '11:00').toISOString(), items: [item('x', '15:35', 'macro')] },
      since,
      now,
    );
    expect(block.available && (block.value as { stale: boolean }).stale).toBe(true);
  });

  it('with no items and a stale store, the absence is a failure to look, not quiet news', () => {
    const block = newsSinceCloseBlock({ lastFetchAt: null, items: [] }, since, now);
    expect(block.available).toBe(false);
    if (block.available) return;
    expect(block.reason).toMatch(/not been refreshed since the last close/);
  });

  it('with no items and a fresh store, "nothing published" is stated as a finding', () => {
    const block = newsSinceCloseBlock({ lastFetchAt: now.toISOString(), items: [] }, since, now);
    expect(block.available && (block.value as { items: unknown[] }).items).toEqual([]);
  });
});

describe('oiAnalysisBlock — build-up, PCR, walls, max pain and the change vs the previous session', () => {
  const raw: RawOiAnalysis = {
    available: true,
    source: 'options-chain.service',
    at: '2026-10-12T10:14:00.000Z',
    expiry: '2026-10-13',
    spot: 25050,
    pcr: 0.82,
    maxPain: 25000,
    callWall: 25200,
    putWall: 24800,
    totalCeOi: 1_000_000,
    totalPeOi: 820_000,
    totalOiChange: 90_000,
    underlyingPriceChange: { value: -110, source: 'yahoo-finance.service (session change vs previous close)' },
    prevSession: { at: '2026-10-09T10:00:00.000Z', pcr: 1.05, totalCeOi: 900_000, totalPeOi: 945_000, spot: 25160 },
    contract: {
      strike: 25000,
      optionType: 'CE',
      ltp: 120,
      oi: 50_000,
      oiChange: 8_000,
      prev: { ltp: 160, oi: 42_000 },
    },
  };

  it('classifies the contract and the underlying, and reports PCR, walls and max pain', () => {
    const block = oiAnalysisBlock(raw);
    expect(block.available).toBe(true);
    if (!block.available) return;
    const v = block.value as Record<string, any>;
    expect(v.pcr).toEqual(expect.objectContaining({ available: true, value: 0.82 }));
    expect(v.maxPain).toEqual(expect.objectContaining({ available: true, value: 25000 }));
    expect(v.walls).toEqual(expect.objectContaining({ available: true, value: { callWall: 25200, putWall: 24800 } }));
    // Premium fell 40 while OI rose 8000 -> writers adding: short build-up.
    expect(v.contract.value).toEqual(expect.objectContaining({ priceChange: -40, oiChange: 8000, buildUp: 'SHORT_BUILD_UP' }));
    // Spot fell 110 while chain OI rose 90k -> short build-up (proxy, labelled).
    expect(v.underlying.value).toEqual(expect.objectContaining({ buildUp: 'SHORT_BUILD_UP' }));
    expect(v.underlying.source).toMatch(/proxy/i);
    expect(v.vsPreviousSession.value).toEqual(expect.objectContaining({ pcrThen: 1.05, pcrChange: -0.23 }));
  });

  it('marks each missing piece unavailable — never zero', () => {
    const block = oiAnalysisBlock({
      ...raw,
      pcr: null,
      maxPain: null,
      callWall: null,
      putWall: null,
      prevSession: null,
      contract: null,
      underlyingPriceChange: null,
    });
    expect(block.available).toBe(true);
    if (!block.available) return;
    const v = block.value as Record<string, any>;
    for (const key of ['pcr', 'maxPain', 'walls', 'vsPreviousSession', 'contract', 'underlying']) {
      expect({ key, available: v[key].available }).toEqual({ key, available: false });
      expect(typeof v[key].reason).toBe('string');
    }
  });

  it('passes an unavailable chain through as a stated absence', () => {
    expect(oiAnalysisBlock({ available: false, reason: 'no options chain for MCX GOLD' })).toEqual({
      available: false,
      reason: 'no options chain for MCX GOLD',
    });
  });
});

describe('cueBlock — value, direction and freshness for each market cue', () => {
  const now = ist('2026-10-12', '15:45');
  it('reports value, change, direction and age', () => {
    const block = cueBlock({ value: 5600, change: -84, changePercent: -1.5, at: ist('2026-10-12', '15:40').toISOString() }, 'commodities-snapshot.service (MCX CRUDEOIL front month)', now);
    expect(block).toEqual({
      available: true,
      value: { value: 5600, change: -84, changePercent: -1.5, direction: 'DOWN', ageMinutes: 5 },
      source: 'commodities-snapshot.service (MCX CRUDEOIL front month)',
      at: ist('2026-10-12', '15:40').toISOString(),
    });
  });
  it('reads a tiny move as FLAT', () => {
    const block = cueBlock({ value: 14, change: 0.01, changePercent: 0.05, at: now.toISOString() }, 's', now);
    expect(block.available && block.value.direction).toBe('FLAT');
  });
  it('is absent with a reason when the value is not a finite reading', () => {
    expect(cueBlock({ value: Number.NaN, change: 0, changePercent: 0, at: now.toISOString() }, 's', now).available).toBe(false);
    expect(cueBlock(null, 's', now, 'no quote')).toEqual({ available: false, reason: 'no quote' });
  });
});
