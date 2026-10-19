import { parseMbmConfig } from '../mbm.config';
import { MBM_CACHE_MS, MbmClient } from './mbm-client.service';

const ok = { instrument: 'NIFTY', status: 'ok', asOf: '2026-10-20T04:15:00Z', horizons: {}, featureSet: 'mbm-fs2', dataQuality: 'ok' };
const res = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body });
const on = parseMbmConfig({ MBM_ENABLED: 'observe', MBM_URL: 'http://mbm:5100' });

describe('MbmClient', () => {
  it('GETs ${MBM_URL}/behaviour/:instrument and returns the body', async () => {
    const f = jest.fn().mockResolvedValue(res(ok));
    const c = new MbmClient(on, f);
    await expect(c.behaviour('nifty')).resolves.toEqual(ok);
    expect(f).toHaveBeenCalledWith('http://mbm:5100/behaviour/NIFTY', { signal: expect.any(Object) });
  });

  it('caches successes for 60 s', async () => {
    const f = jest.fn().mockResolvedValue(res(ok));
    const c = new MbmClient(on, f);
    await c.behaviour('NIFTY', 1_000);
    await c.behaviour('NIFTY', 1_000 + MBM_CACHE_MS - 1);
    expect(f).toHaveBeenCalledTimes(1);
    await c.behaviour('NIFTY', 1_000 + MBM_CACHE_MS);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['network error', () => Promise.reject(new Error('ECONNREFUSED'))],
    ['5xx', () => Promise.resolve(res({ detail: 'boom' }, 500))],
    ['malformed body', () => Promise.resolve(res({ hello: 1 }))],
    ['bad json', () => Promise.resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } })],
  ])('fails open on %s', async (_name, impl) => {
    const c = new MbmClient(on, jest.fn(impl as never));
    await expect(c.behaviour('NIFTY')).resolves.toEqual({ instrument: 'NIFTY', status: 'absent' });
  });

  it('fails open on timeout (aborts after 800 ms)', async () => {
    jest.useFakeTimers();
    try {
      const f = jest.fn((_u: string, init: { signal: AbortSignal }) =>
        new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))),
      );
      const p = new MbmClient(on, f as never).behaviour('NIFTY');
      jest.advanceTimersByTime(800);
      await expect(p).resolves.toEqual({ instrument: 'NIFTY', status: 'absent' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('answers absent without a call when off or for an unsafe instrument', async () => {
    const f = jest.fn();
    await expect(new MbmClient(parseMbmConfig({}), f).behaviour('NIFTY')).resolves.toMatchObject({ status: 'absent' });
    await expect(new MbmClient(on, f).behaviour('../health')).resolves.toMatchObject({ status: 'absent' });
    expect(f).not.toHaveBeenCalled();
  });
});
