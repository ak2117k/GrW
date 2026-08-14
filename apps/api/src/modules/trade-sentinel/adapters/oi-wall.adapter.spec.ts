import { SentinelOiWallSource } from './oi-wall.adapter';

describe('SentinelOiWallSource', () => {
  const walls = jest.fn();
  const svc = new SentinelOiWallSource({ walls } as never);

  beforeEach(() => jest.clearAllMocks());

  it('passes the underlying spot through — it is what sides the walls OTM', async () => {
    walls.mockResolvedValue([]);
    await svc.walls('NIFTY', 24010);
    // A missing/zero spot disables the OTM filter inside OiWallService and
    // yields ITM strikes labelled as walls, which the snapshot service would
    // then PERSIST and diff against.
    expect(walls).toHaveBeenCalledWith('NIFTY', 24010);
  });

  it('drops the rank score, so nothing downstream can read it as open interest', async () => {
    walls.mockResolvedValue([
      { price: 24500, kind: 'OI_CALL', score: 30 },
      { price: 23500, kind: 'OI_PUT', score: 20 },
    ]);

    await expect(svc.walls('NIFTY', 24010)).resolves.toEqual([
      { price: 24500, kind: 'OI_CALL' },
      { price: 23500, kind: 'OI_PUT' },
    ]);
  });

  it('preserves order — the caller takes the FIRST of each kind as the wall', async () => {
    walls.mockResolvedValue([
      { price: 24500, kind: 'OI_CALL', score: 30 },
      { price: 24600, kind: 'OI_CALL', score: 20 },
    ]);
    const out = await svc.walls('NIFTY', 24010);
    expect(out.map((w) => w.price)).toEqual([24500, 24600]);
  });

  it('passes an empty result through without reinterpreting it', async () => {
    // `[]` means a cash stock, a failed chain fetch, or an unwired
    // options-chain service — indistinguishable, and the snapshot service is
    // the one that says so. Flattening it to null here would lose that.
    walls.mockResolvedValue([]);
    await expect(svc.walls('SUZLON', 105)).resolves.toEqual([]);
  });
});
