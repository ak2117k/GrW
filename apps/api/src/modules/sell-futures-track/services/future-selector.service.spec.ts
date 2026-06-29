import { Test } from '@nestjs/testing';
import { FutureSelectorService } from './future-selector.service';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';

/**
 * Build a raw Angel One ScripMaster FUTSTK row (subset of fields the selector
 * reads). Expiry is the master's "DDMMMYYYY" string, e.g. "30JUN2026".
 */
function futRow(overrides: Partial<Record<string, any>> = {}): Record<string, any> {
  return {
    token: '62802',
    symbol: 'RELIANCE30JUN26FUT',
    name: 'RELIANCE',
    expiry: '30JUN2026',
    lotsize: '500',
    instrumenttype: 'FUTSTK',
    exch_seg: 'NFO',
    ...overrides,
  };
}

describe('FutureSelectorService.resolve', () => {
  let svc: FutureSelectorService;
  let adapter: { fetchInstrumentMaster: jest.Mock };

  beforeEach(async () => {
    adapter = { fetchInstrumentMaster: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        FutureSelectorService,
        { provide: AngelOneAdapterService, useValue: adapter },
      ],
    }).compile();
    svc = mod.get(FutureSelectorService);
  });

  afterEach(() => jest.useRealTimers());

  it('resolves RELIANCE → token / expiry / lotSize from the nearest non-expired contract', async () => {
    // Freeze to a date far before the nearest expiry so no roll happens.
    jest.useFakeTimers({ now: new Date('2026-06-10T06:00:00Z') });
    adapter.fetchInstrumentMaster.mockResolvedValue([
      futRow({ token: '62802', symbol: 'RELIANCE30JUN26FUT', expiry: '30JUN2026' }),
      futRow({ token: '61284', symbol: 'RELIANCE28JUL26FUT', expiry: '28JUL2026' }),
    ]);

    const r = await svc.resolve('RELIANCE');
    expect(r).not.toBeNull();
    expect(r!.token).toBe('62802');
    expect(r!.tradingsymbol).toBe('RELIANCE30JUN26FUT');
    expect(r!.exchange).toBe('NFO');
    expect(r!.lotSize).toBe(500);
    expect(r!.expiry.getFullYear()).toBe(2026);
    expect(r!.expiry.getMonth()).toBe(5); // June (0-indexed)
    expect(r!.expiry.getDate()).toBe(30);
  });

  it('strips a trailing -EQ before matching the underlying', async () => {
    jest.useFakeTimers({ now: new Date('2026-06-10T06:00:00Z') });
    adapter.fetchInstrumentMaster.mockResolvedValue([futRow()]);

    const r = await svc.resolve('RELIANCE-EQ');
    expect(r).not.toBeNull();
    expect(r!.token).toBe('62802');
  });

  it('returns null when the stock has no future (non-F&O smallcap)', async () => {
    jest.useFakeTimers({ now: new Date('2026-06-10T06:00:00Z') });
    adapter.fetchInstrumentMaster.mockResolvedValue([futRow()]); // only RELIANCE
    const r = await svc.resolve('IRIS');
    expect(r).toBeNull();
  });

  it('picks the current-month contract when well before expiry', async () => {
    jest.useFakeTimers({ now: new Date('2026-06-10T06:00:00Z') }); // 20 days to 30Jun
    adapter.fetchInstrumentMaster.mockResolvedValue([
      futRow({ token: 'JUN', symbol: 'RELIANCE30JUN26FUT', expiry: '30JUN2026' }),
      futRow({ token: 'JUL', symbol: 'RELIANCE28JUL26FUT', expiry: '28JUL2026' }),
    ]);
    const r = await svc.resolve('RELIANCE');
    expect(r!.token).toBe('JUN');
  });

  it('rolls to the next month when within ROLL_DAYS of the nearest expiry', async () => {
    // 28Jun is 2 days before 30Jun expiry → within ROLL_DAYS (3) → roll to July.
    jest.useFakeTimers({ now: new Date('2026-06-28T06:00:00Z') });
    adapter.fetchInstrumentMaster.mockResolvedValue([
      futRow({ token: 'JUN', symbol: 'RELIANCE30JUN26FUT', expiry: '30JUN2026' }),
      futRow({ token: 'JUL', symbol: 'RELIANCE28JUL26FUT', expiry: '28JUL2026' }),
    ]);
    const r = await svc.resolve('RELIANCE');
    expect(r!.token).toBe('JUL');
  });

  it('does NOT roll past the only remaining contract (keeps near expiry if no next month)', async () => {
    jest.useFakeTimers({ now: new Date('2026-06-29T06:00:00Z') }); // 1 day to expiry, within roll
    adapter.fetchInstrumentMaster.mockResolvedValue([
      futRow({ token: 'JUN', symbol: 'RELIANCE30JUN26FUT', expiry: '30JUN2026' }),
    ]);
    const r = await svc.resolve('RELIANCE');
    expect(r!.token).toBe('JUN');
  });

  it('bridges a name-normalization gap (matches on the futures tradingsymbol prefix)', async () => {
    // The master `name` differs (e.g. legacy/renamed), but the tradingsymbol
    // still begins with the underlying + expiry. Selector must still resolve.
    jest.useFakeTimers({ now: new Date('2026-06-10T06:00:00Z') });
    adapter.fetchInstrumentMaster.mockResolvedValue([
      futRow({ token: 'BAJ', name: 'BAJAJ AUTO LTD', symbol: 'BAJAJAUTO30JUN26FUT', expiry: '30JUN2026', lotsize: '75' }),
    ]);
    const r = await svc.resolve('BAJAJAUTO');
    expect(r).not.toBeNull();
    expect(r!.token).toBe('BAJ');
    expect(r!.lotSize).toBe(75);
  });

  it('skips already-expired contracts', async () => {
    jest.useFakeTimers({ now: new Date('2026-07-10T06:00:00Z') }); // June already expired
    adapter.fetchInstrumentMaster.mockResolvedValue([
      futRow({ token: 'JUN', symbol: 'RELIANCE30JUN26FUT', expiry: '30JUN2026' }),
      futRow({ token: 'JUL', symbol: 'RELIANCE28JUL26FUT', expiry: '28JUL2026' }),
    ]);
    const r = await svc.resolve('RELIANCE');
    expect(r!.token).toBe('JUL');
  });
});
