import { contractByToken, contractsByTokens, pickContract, type ContractRow } from './contract-by-token';

const d = (s: string) => new Date(s);

/** The 2026-11-26 case: Angel re-used NFO token 90007 (BDL Aug option, expired) for a BHEL Dec option. */
const BDL: ContractRow = {
  id: 'bdl', symbol: 'BDL25AUG261500CE', name: 'BDL', exchange: 'NFO', token: '90007', lotSize: 325, tickSize: 0.05,
  expiry: d('2026-08-25T00:00:00Z'), strike: 1500, optionType: 'CE', isActive: false,
  createdAt: d('2026-08-17T18:18:57Z'), updatedAt: d('2026-08-26T02:00:00Z'),
};
const BHEL: ContractRow = {
  id: 'bhel', symbol: 'BHEL29DEC26420PE', name: 'BHEL', exchange: 'NFO', token: '90007', lotSize: 2625, tickSize: 0.05,
  expiry: d('2026-12-29T00:00:00Z'), strike: 420, optionType: 'PE', isActive: true,
  createdAt: d('2026-10-09T02:31:02Z'), updatedAt: d('2026-11-26T02:30:00Z'),
};
const TODAY = d('2026-11-26T06:54:32Z');

describe('pickContract', () => {
  it('picks the live contract, not the expired one that used the token before (either row order)', () => {
    expect(pickContract([BDL, BHEL], { at: TODAY })?.id).toBe('bhel');
    expect(pickContract([BHEL, BDL], { at: TODAY })?.id).toBe('bhel');
  });

  it('a past instant resolves to the contract that held the token then', () => {
    // 2026-08-20: BDL was live; the BHEL row did not exist yet.
    expect(pickContract([BHEL, BDL], { at: d('2026-08-20T05:00:00Z') })?.id).toBe('bdl');
  });

  it('a contract is still the holder on its own expiry day (IST)', () => {
    expect(pickContract([BHEL, BDL], { at: d('2026-08-25T09:00:00Z') })?.id).toBe('bdl');
  });

  it('a matching symbol hint wins over every other rule', () => {
    expect(pickContract([BDL, BHEL], { at: TODAY, symbol: 'bdl25aug261500ce' })?.id).toBe('bdl');
  });

  it('a symbol hint that matches nothing falls back to the time rules', () => {
    expect(pickContract([BDL, BHEL], { at: TODAY, symbol: 'SOMETHING' })?.id).toBe('bhel');
  });

  it('a single row is returned as is (equities, indices: no expiry)', () => {
    const eq: ContractRow = { ...BHEL, id: 'eq', symbol: 'BHEL-EQ', exchange: 'NSE', token: '438', expiry: null, optionType: null, strike: null };
    expect(pickContract([eq], { at: TODAY })?.id).toBe('eq');
  });

  it('when every row is expired, the most recently expired one wins', () => {
    const older = { ...BDL, id: 'older', expiry: d('2026-05-26T00:00:00Z'), createdAt: d('2026-03-01T00:00:00Z') };
    expect(pickContract([older, BDL], { at: TODAY })?.id).toBe('bdl');
  });

  it('two live rows: the active one, then the nearer expiry', () => {
    const inactive = { ...BHEL, id: 'inactive', isActive: false };
    expect(pickContract([inactive, BHEL], { at: TODAY })?.id).toBe('bhel');
    const later = { ...BHEL, id: 'later', expiry: d('2027-01-26T00:00:00Z') };
    expect(pickContract([later, BHEL], { at: TODAY })?.id).toBe('bhel');
  });

  it('empty input gives null', () => {
    expect(pickContract([], { at: TODAY })).toBeNull();
  });
});

describe('contractByToken / contractsByTokens', () => {
  const rows = [BDL, BHEL, { ...BHEL, id: 'eq', symbol: 'BHEL-EQ', exchange: 'NSE', token: '438', expiry: null }];
  const prisma = {
    instrument: {
      findMany: jest.fn(async (args: { where: { OR: Array<{ exchange: string; token: string }> } }) =>
        rows.filter((r) => args.where.OR.some((w) => w.exchange === r.exchange && w.token === r.token)),
      ),
    },
  };

  it('resolves one token through the rules', async () => {
    expect((await contractByToken(prisma, 'NFO', '90007', { at: TODAY }))?.symbol).toBe('BHEL29DEC26420PE');
    expect(await contractByToken(prisma, 'NFO', 'nope', { at: TODAY })).toBeNull();
  });

  it('resolves many in one query, results aligned with the refs', async () => {
    prisma.instrument.findMany.mockClear();
    const out = await contractsByTokens(prisma, [
      { exchange: 'NFO', token: '90007', at: TODAY },
      { exchange: 'NSE', token: '438', at: TODAY },
      { exchange: 'NFO', token: 'nope', at: TODAY },
    ]);
    expect(prisma.instrument.findMany).toHaveBeenCalledTimes(1);
    expect(out.map((r) => r?.symbol ?? null)).toEqual(['BHEL29DEC26420PE', 'BHEL-EQ', null]);
  });

  it('the same token asked at two instants resolves per instant', async () => {
    const out = await contractsByTokens(prisma, [
      { exchange: 'NFO', token: '90007', at: d('2026-08-20T05:00:00Z') },
      { exchange: 'NFO', token: '90007', at: TODAY },
      { exchange: 'NFO', token: '90007', at: TODAY, symbol: 'BDL25AUG261500CE' },
    ]);
    expect(out.map((r) => r?.name)).toEqual(['BDL', 'BHEL', 'BDL']);
  });

  it('exchange is matched case-insensitively on the way in (callers pass "nfo")', async () => {
    const out = await contractsByTokens(prisma, [{ exchange: 'nfo', token: '90007', at: TODAY }]);
    expect(out[0]?.name).toBe('BHEL');
  });

  it('no refs → no query', async () => {
    prisma.instrument.findMany.mockClear();
    expect(await contractsByTokens(prisma, [])).toEqual([]);
    expect(prisma.instrument.findMany).not.toHaveBeenCalled();
  });
});
