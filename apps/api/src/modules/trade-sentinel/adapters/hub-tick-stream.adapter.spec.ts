import { HubTickStream } from './hub-tick-stream.adapter';

describe('HubTickStream', () => {
  it('forwards hub prices as keyed ticks, drops db-sourced and non-positive ones', () => {
    let listener!: (p: unknown) => void;
    const hub = { onPrice: jest.fn((fn) => { listener = fn; return () => undefined; }) };
    const source = { hubFor: jest.fn(() => hub), record: jest.fn() };
    const s = new HubTickStream({ get: () => source } as never);
    const got: unknown[] = [];
    expect(s.subscribe('u1', (t) => got.push(t))).toBeInstanceOf(Function);
    expect(source.hubFor).toHaveBeenCalledWith('u1', 'positions');
    listener({ ref: { exchange: 'NSE', token: '1', symbol: 'X' }, ltp: 10, at: 5, source: 'ws' });
    listener({ ref: { exchange: 'NSE', token: '1', symbol: 'X' }, ltp: 10, at: 6, source: 'db' });
    listener({ ref: { exchange: 'NSE', token: '1', symbol: 'X' }, ltp: 0, at: 7, source: 'ws' });
    expect(got).toEqual([{ key: 'NSE:1', ltp: 10, at: 5 }]);
  });

  it('no hub for the user → null (nothing subscribed)', () => {
    const s = new HubTickStream({ get: () => ({ hubFor: () => null, record: jest.fn() }) } as never);
    expect(s.subscribe('u1', () => undefined)).toBeNull();
  });
});
