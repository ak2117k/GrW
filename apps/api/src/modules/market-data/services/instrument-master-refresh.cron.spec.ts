import { InstrumentMasterRefreshCron } from './instrument-master-refresh.cron';

describe('InstrumentMasterRefreshCron', () => {
  it('calls refreshMaster on boot with cash-equity rows mapped to the upsert shape', async () => {
    const instruments = { refreshMaster: jest.fn().mockResolvedValue(1), ensureCoreIndexInstruments: jest.fn().mockResolvedValue(0), lastMasterRefreshAt: jest.fn().mockResolvedValue(null) } as any;
    const adapter = {
      getInstrumentMaster: jest.fn().mockResolvedValue([
        {
          symbol: 'NEOGEN-EQ',
          token: '123',
          name: 'NEOGEN CHEMICALS',
          exch_seg: 'NSE',
          instrumenttype: '',
          lotsize: '1',
          tick_size: '5',
        },
      ]),
    } as any;

    const cron = new InstrumentMasterRefreshCron(instruments, adapter);
    await cron.onModuleInit();
    // The boot refresh is detached; let it run.
    await new Promise((r) => setImmediate(r));

    expect(adapter.getInstrumentMaster).toHaveBeenCalledTimes(1);
    expect(instruments.refreshMaster).toHaveBeenCalledTimes(1);
    const rows = instruments.refreshMaster.mock.calls[0][0];
    expect(rows[0]).toMatchObject({
      symbol: 'NEOGEN-EQ',
      token: '123',
      exchange: 'NSE',
      segment: 'NSE',
      lotSize: 1,
      tickSize: 5,
    });
  });

  it('excludes F&O/commodity contract rows (blank-instrumenttype cash equities only)', async () => {
    const instruments = { refreshMaster: jest.fn().mockResolvedValue(0), ensureCoreIndexInstruments: jest.fn().mockResolvedValue(0) } as any;
    const adapter = {
      getInstrumentMaster: jest.fn().mockResolvedValue([
        { symbol: 'RELIANCE-EQ', token: '2885', name: 'RELIANCE', exch_seg: 'NSE', instrumenttype: '' },
        { symbol: 'NIFTY24APR22000CE', token: '999', name: 'NIFTY', exch_seg: 'NFO', instrumenttype: 'OPTIDX' },
        { symbol: 'CRUDEOILFUT', token: '888', name: 'CRUDEOIL', exch_seg: 'MCX', instrumenttype: 'FUTCOM' },
      ]),
    } as any;

    const cron = new InstrumentMasterRefreshCron(instruments, adapter);
    await cron.refreshDaily();

    const rows = instruments.refreshMaster.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe('RELIANCE-EQ');
  });

  it('never throws when the adapter fetch fails (must not crash boot or the scheduler)', async () => {
    const instruments = { refreshMaster: jest.fn(), ensureCoreIndexInstruments: jest.fn().mockResolvedValue(0), lastMasterRefreshAt: jest.fn().mockResolvedValue(null) } as any;
    const adapter = {
      getInstrumentMaster: jest.fn().mockRejectedValue(new Error('CDN down')),
    } as any;

    const cron = new InstrumentMasterRefreshCron(instruments, adapter);
    await expect(cron.onModuleInit()).resolves.toBeUndefined();
    expect(instruments.refreshMaster).not.toHaveBeenCalled();
  });

  describe('core index rows (the master never carries them)', () => {
    const order: string[] = [];
    const make = (lastRefresh: Date | null) => {
      order.length = 0;
      const instruments = {
        lastMasterRefreshAt: jest.fn(async () => { order.push('freshness'); return lastRefresh; }),
        ensureCoreIndexInstruments: jest.fn(async () => { order.push('ensure'); return 0; }),
        refreshMaster: jest.fn(async () => { order.push('refresh'); return 0; }),
      } as any;
      const adapter = { getInstrumentMaster: jest.fn().mockResolvedValue([]) } as any;
      return { instruments, cron: new InstrumentMasterRefreshCron(instruments, adapter) };
    };

    it('ensures them at boot even when the master refresh is skipped as fresh', async () => {
      const { instruments, cron } = make(new Date());
      await (cron as any).refreshOnBoot();
      expect(instruments.ensureCoreIndexInstruments).toHaveBeenCalledTimes(1);
      expect(instruments.refreshMaster).not.toHaveBeenCalled();
    });

    it('decides freshness BEFORE ensuring, so seeding index rows cannot fake a fresh table', async () => {
      const { cron } = make(null);
      await (cron as any).refreshOnBoot();
      expect(order[0]).toBe('freshness');
      expect(order).toContain('ensure');
    });

    it('ensures them on the daily refresh too', async () => {
      const { instruments, cron } = make(null);
      await cron.refreshDaily();
      expect(instruments.ensureCoreIndexInstruments).toHaveBeenCalledTimes(1);
    });
  });

  describe('listing refresh (09:20 IST): only cash symbols not in the table yet', () => {
    const master = [
      { symbol: 'JPL-EQ', token: '766830', name: 'JPL', exch_seg: 'NSE', instrumenttype: '', lotsize: '1', tick_size: '10' },
      { symbol: 'SAIL-EQ', token: '2963', name: 'SAIL', exch_seg: 'NSE', instrumenttype: '', lotsize: '1', tick_size: '1' },
    ];

    it('downloads the master fresh and upserts just the new listing', async () => {
      const instruments = { refreshMaster: jest.fn().mockResolvedValue(1), getByExchangeTokenSync: jest.fn((_e: string, t: string) => (t === '2963' ? { token: t } : null)) } as any;
      const adapter = { getInstrumentMaster: jest.fn().mockResolvedValue(master) } as any;
      const n = await new InstrumentMasterRefreshCron(instruments, adapter).refreshListings();
      expect(adapter.getInstrumentMaster).toHaveBeenCalledWith({ fresh: true });
      expect(instruments.refreshMaster).toHaveBeenCalledWith([expect.objectContaining({ symbol: 'JPL-EQ', token: '766830', exchange: 'NSE' })]);
      expect(n).toBe(1);
    });

    it('nothing new: no write; a failed download never throws', async () => {
      const instruments = { refreshMaster: jest.fn(), getByExchangeTokenSync: jest.fn(() => ({})) } as any;
      expect(await new InstrumentMasterRefreshCron(instruments, { getInstrumentMaster: jest.fn().mockResolvedValue(master) } as any).refreshListings()).toBe(0);
      expect(instruments.refreshMaster).not.toHaveBeenCalled();
      expect(await new InstrumentMasterRefreshCron(instruments, { getInstrumentMaster: jest.fn().mockRejectedValue(new Error('cdn down')) } as any).refreshListings()).toBe(0);
    });
  });
});
