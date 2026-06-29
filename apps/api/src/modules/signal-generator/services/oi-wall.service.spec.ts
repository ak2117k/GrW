import { OiWallService } from './oi-wall.service';

describe('OiWallService', () => {
  const chain = [
    { strikePrice: 100, ceData: { oi: 10 }, peData: { oi: 90 } },
    { strikePrice: 110, ceData: { oi: 80 }, peData: { oi: 20 } },
    { strikePrice: 120, ceData: { oi: 50 }, peData: { oi: 5 } },
    { strikePrice: 90, ceData: { oi: 5 }, peData: { oi: 70 } },
  ];

  function svc(getExpiries: jest.Mock, getOptionsChain: jest.Mock) {
    return new OiWallService({ getExpiries, getOptionsChain } as never);
  }

  it('returns [] for a non-F&O symbol (no expiries)', async () => {
    const s = svc(jest.fn().mockResolvedValue([]), jest.fn());
    expect(await s.walls('CUPID', 105)).toEqual([]);
  });

  it('returns top-2 call strikes as resistance (score 30/20) and top-2 put strikes as support', async () => {
    const s = svc(
      jest.fn().mockResolvedValue(['2026-06-25']),
      jest.fn().mockResolvedValue(chain),
    );
    const walls = await s.walls('NIFTY', 105);
    const res = walls.filter((w) => w.kind === 'OI_CALL').sort((a, b) => b.score - a.score);
    const sup = walls.filter((w) => w.kind === 'OI_PUT').sort((a, b) => b.score - a.score);
    expect(res[0]).toMatchObject({ price: 110, score: 30 });
    expect(res[1]).toMatchObject({ price: 120, score: 20 });
    expect(sup[0]).toMatchObject({ price: 100, score: 30 });
    expect(sup[1]).toMatchObject({ price: 90, score: 20 });
  });

  it('returns [] and does not throw when the chain fetch fails', async () => {
    const s = svc(
      jest.fn().mockResolvedValue(['2026-06-25']),
      jest.fn().mockRejectedValue(new Error('boom')),
    );
    expect(await s.walls('NIFTY', 105)).toEqual([]);
  });

  it('excludes ITM high-OI strikes (call below spot / put above spot) — only OTM walls count', async () => {
    const ltp = 105;
    const itmChain = [
      ...chain,
      { strikePrice: 95, ceData: { oi: 999 }, peData: { oi: 1 } },  // ITM call, huge OI — must be excluded
      { strikePrice: 115, ceData: { oi: 1 }, peData: { oi: 999 } }, // ITM put, huge OI — must be excluded
    ];
    const s = svc(
      jest.fn().mockResolvedValue(['2026-06-25']),
      jest.fn().mockResolvedValue(itmChain),
    );
    const walls = await s.walls('NIFTY', ltp);
    // No call wall below spot, no put wall above spot.
    expect(walls.filter((w) => w.kind === 'OI_CALL').every((w) => w.price > ltp)).toBe(true);
    expect(walls.filter((w) => w.kind === 'OI_PUT').every((w) => w.price < ltp)).toBe(true);
    // The 999-OI ITM strikes are dropped despite being the highest OI.
    expect(walls.some((w) => w.price === 95)).toBe(false);
    expect(walls.some((w) => w.price === 115)).toBe(false);
    // Genuine OTM walls remain the chosen ones.
    expect(walls.find((w) => w.kind === 'OI_CALL')).toMatchObject({ price: 110, score: 30 });
    expect(walls.find((w) => w.kind === 'OI_PUT')).toMatchObject({ price: 100, score: 30 });
  });

  // ─────────────────────────────────────────────────────
  // wallsExtended: static walls + max-pain + OI-change
  // ─────────────────────────────────────────────────────
  describe('wallsExtended', () => {
    it('returns [] for a non-F&O symbol (no expiries)', async () => {
      const s = svc(jest.fn().mockResolvedValue([]), jest.fn());
      expect(await s.wallsExtended('CUPID', 105)).toEqual([]);
    });

    it('returns [] and does not throw when the chain fetch fails', async () => {
      const s = svc(
        jest.fn().mockResolvedValue(['2026-06-25']),
        jest.fn().mockRejectedValue(new Error('boom')),
      );
      expect(await s.wallsExtended('NIFTY', 105)).toEqual([]);
    });

    it('preserves the static OI walls (same as walls())', async () => {
      const s = svc(
        jest.fn().mockResolvedValue(['2026-06-25']),
        jest.fn().mockResolvedValue(chain),
      );
      const ext = await s.wallsExtended('NIFTY', 105);
      const res = ext.filter((w) => w.kind === 'OI_CALL').sort((a, b) => b.score - a.score);
      const sup = ext.filter((w) => w.kind === 'OI_PUT').sort((a, b) => b.score - a.score);
      expect(res[0]).toMatchObject({ price: 110, score: 30 });
      expect(res[1]).toMatchObject({ price: 120, score: 20 });
      expect(sup[0]).toMatchObject({ price: 100, score: 30 });
      expect(sup[1]).toMatchObject({ price: 90, score: 20 });
    });

    it('emits exactly one MAX_PAIN candidate at the minimum-writer-payoff strike', async () => {
      // Hand-computed over the chain: writer payoff is minimized at strike 110
      // (pain: 90→1450, 100→350, 110→250, 120→1150).
      const s = svc(
        jest.fn().mockResolvedValue(['2026-06-25']),
        jest.fn().mockResolvedValue(chain),
      );
      const ext = await s.wallsExtended('NIFTY', 105);
      const mp = ext.filter((w) => w.kind === 'MAX_PAIN');
      expect(mp).toHaveLength(1);
      expect(mp[0]).toMatchObject({ price: 110, score: 25 });
    });

    it('adds OI_CHANGE candidates at the largest OTM OI build-up strikes (score 30/20)', async () => {
      const ltp = 105;
      const changeChain = [
        { strikePrice: 100, ceData: { oi: 10, oiChange: 5 },   peData: { oi: 90, oiChange: 200 } }, // OTM put +200
        { strikePrice: 110, ceData: { oi: 80, oiChange: 300 }, peData: { oi: 20, oiChange: 10 } },  // OTM call +300 (biggest)
        { strikePrice: 120, ceData: { oi: 50, oiChange: 150 }, peData: { oi: 5, oiChange: 5 } },    // OTM call +150
        { strikePrice: 90,  ceData: { oi: 5, oiChange: 1 },    peData: { oi: 70, oiChange: 50 } },  // OTM put +50
      ];
      const s = svc(
        jest.fn().mockResolvedValue(['2026-06-25']),
        jest.fn().mockResolvedValue(changeChain),
      );
      const ext = await s.wallsExtended('NIFTY', ltp);
      const oc = ext.filter((w) => w.kind === 'OI_CHANGE').sort((a, b) => b.score - a.score);
      expect(oc).toHaveLength(2);
      expect(oc[0]).toMatchObject({ price: 110, score: 30 }); // biggest build-up
      expect(oc[1]).toMatchObject({ price: 100, score: 20 }); // next biggest
    });

    it('excludes ITM strikes from OI_CHANGE walls (only OTM build-ups count)', async () => {
      const ltp = 105;
      const changeChain = [
        { strikePrice: 95,  ceData: { oi: 1, oiChange: 9999 }, peData: { oi: 1, oiChange: 1 } },   // ITM call build-up — excluded
        { strikePrice: 115, ceData: { oi: 1, oiChange: 1 },    peData: { oi: 1, oiChange: 9999 } },// ITM put build-up — excluded
        { strikePrice: 110, ceData: { oi: 1, oiChange: 300 },  peData: { oi: 1, oiChange: 1 } },   // OTM call
        { strikePrice: 100, ceData: { oi: 1, oiChange: 1 },    peData: { oi: 1, oiChange: 200 } }, // OTM put
      ];
      const s = svc(
        jest.fn().mockResolvedValue(['2026-06-25']),
        jest.fn().mockResolvedValue(changeChain),
      );
      const ext = await s.wallsExtended('NIFTY', ltp);
      const oc = ext.filter((w) => w.kind === 'OI_CHANGE');
      expect(oc.some((w) => w.price === 95)).toBe(false);
      expect(oc.some((w) => w.price === 115)).toBe(false);
      expect(oc.map((w) => w.price).sort((a, b) => a - b)).toEqual([100, 110]);
    });

    it('skips OI_CHANGE cleanly when the chain exposes no change data', async () => {
      // The base `chain` has no oiChange fields — nothing to build from.
      const s = svc(
        jest.fn().mockResolvedValue(['2026-06-25']),
        jest.fn().mockResolvedValue(chain),
      );
      const ext = await s.wallsExtended('NIFTY', 105);
      expect(ext.some((w) => w.kind === 'OI_CHANGE')).toBe(false);
      // Static walls + max-pain still present.
      expect(ext.some((w) => w.kind === 'OI_CALL')).toBe(true);
      expect(ext.some((w) => w.kind === 'MAX_PAIN')).toBe(true);
    });
  });
});
