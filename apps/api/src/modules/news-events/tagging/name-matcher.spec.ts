import { blankSpans, NameMatcher } from './name-matcher';
import { deriveAliases } from './alias-derivation';
import { CURATED_ALIASES } from './curated-aliases';

const m = new NameMatcher(
  deriveAliases(
    [
      { symbol: 'TATAMOTORS', name: 'Tata Motors Limited' },
      { symbol: 'TATASTEEL', name: 'Tata Steel Limited' },
      { symbol: 'SENCO', name: 'Senco Gold Limited' },
      { symbol: 'HINDZINC', name: 'Hindustan Zinc Limited' },
      { symbol: 'COALINDIA', name: 'Coal India Limited' },
      { symbol: 'OIL', name: 'Oil India Limited' },
      { symbol: 'IOC', name: 'Indian Oil Corporation Limited' },
      { symbol: 'LT', name: 'Larsen & Toubro Limited' },
    ],
    CURATED_ALIASES,
  ),
);

it.each([
  ['Tata Steel cuts European output', ['TATASTEEL']],
  ['Tata Motors recalls 10,000 cars (a demerged parent name: both successors, see AMBIGUOUS_ALIASES)', ['TMCV', 'TMPV']],
  ['Tata group shares mixed', []],
  ['Senco Gold Q2 profit doubles', ['SENCO']],
  ['Hindustan Zinc raises output', ['HINDZINC']],
  ['Coal India and Oil India rise', ['COALINDIA', 'OIL']],
  ['Indian Oil Corporation cuts prices', ['IOC']],
  ['L&T bags order; Larsen & Toubro shares up', ['LT']],
  ['tata motors (lower case) is not the alias as written', []],
  ['TATA MOTORS RECALLS CARS ACROSS INDIA TODAY', []],
])('%s', (text, want) => {
  expect(m.match(text).symbols).toEqual(want);
});

it('longest match wins and the span is consumed', () => {
  const text = 'Senco Gold jumps as gold prices rise';
  const r = m.match(text);
  expect(r.spans).toEqual([[0, 10]]);
  expect(blankSpans(text, r.spans)).toBe('           jumps as gold prices rise');
});

it('blocked rows never enter the trie', () => {
  const b = new NameMatcher([{ symbol: 'X', alias: 'Xylo Corp', kind: 'blocked' }]);
  expect(b.size).toBe(0);
  expect(b.match('Xylo Corp rallies').symbols).toEqual([]);
});

it('one pass regardless of alias count: 20k aliases match in < 2 ms per article', () => {
  const big = new NameMatcher(Array.from({ length: 20_000 }, (_, i) => ({ symbol: `S${i}`, alias: `Company${i} Industries`, kind: 'official' as const })));
  const text = 'Company19999 Industries reports results; '.repeat(10);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 100; i++) big.match(text);
  expect(Number(process.hrtime.bigint() - t0) / 1e6 / 100).toBeLessThan(2);
  expect(big.approxBytes()).toBeLessThan(2 * 1024 * 1024 * 2); // spec: ≤ 2 MB for ~2k real aliases; 20k synthetic stays < 4 MB
});

describe('an alias with several owners (Tata Motors demerger) tags every owner', () => {
  const d = new NameMatcher(
    deriveAliases(
      [
        { symbol: 'TMCV', name: 'Tata Motors Limited' },
        { symbol: 'TMPV', name: 'Tata Motors Passenger Vehicles Limited' },
      ],
      CURATED_ALIASES,
    ),
  );
  it.each([
    ['Tata Motors shares slip 3%', ['TMCV', 'TMPV']],
    ['Tata Motors Passenger Vehicles raises prices', ['TMPV']],
    ['Tata Motors CV sales up 9% in September', ['TMCV']],
    ['JLR wholesales fall after cyber attack', ['TMPV']],
  ])('%s', (text, want) => {
    expect([...d.match(text).symbols].sort()).toEqual(want);
  });
});
