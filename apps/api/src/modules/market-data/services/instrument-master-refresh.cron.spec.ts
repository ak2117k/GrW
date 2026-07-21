import { InstrumentMasterRefreshCron } from './instrument-master-refresh.cron';

describe('InstrumentMasterRefreshCron', () => {
  it('calls refreshMaster on boot with cash-equity rows mapped to the upsert shape', async () => {
    const instruments = { refreshMaster: jest.fn().mockResolvedValue(1) } as any;
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
    const instruments = { refreshMaster: jest.fn().mockResolvedValue(0) } as any;
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
    const instruments = { refreshMaster: jest.fn() } as any;
    const adapter = {
      getInstrumentMaster: jest.fn().mockRejectedValue(new Error('CDN down')),
    } as any;

    const cron = new InstrumentMasterRefreshCron(instruments, adapter);
    await expect(cron.onModuleInit()).resolves.toBeUndefined();
    expect(instruments.refreshMaster).not.toHaveBeenCalled();
  });
});
