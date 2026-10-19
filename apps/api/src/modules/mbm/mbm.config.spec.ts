import { mbmBootLine, parseMbmConfig } from './mbm.config';
import { MBM_UNIVERSE, universeFor } from './mbm-universe';

describe('parseMbmConfig', () => {
  it('defaults to off / NIFTY / http://mbm:5100 / first auto-exit user', () => {
    const c = parseMbmConfig({ AI_AUTO_EXIT_USER_IDS: ' u1 , u2' });
    expect(c).toEqual({ mode: 'off', instruments: ['NIFTY'], url: 'http://mbm:5100', feedUserId: 'u1', problems: [] });
  });

  it('parses explicit values, upper-cases and de-duplicates instruments, strips the trailing slash', () => {
    const c = parseMbmConfig({
      MBM_ENABLED: ' Observe ',
      MBM_INSTRUMENTS: 'nifty, NIFTY ,banknifty',
      MBM_URL: 'http://localhost:5100/',
      MBM_FEED_USER_ID: 'owner',
      AI_AUTO_EXIT_USER_IDS: 'u1',
    });
    expect(c.mode).toBe('observe');
    expect(c.instruments).toEqual(['NIFTY', 'BANKNIFTY']);
    expect(c.url).toBe('http://localhost:5100');
    expect(c.feedUserId).toBe('owner');
    expect(c.problems).toEqual([]);
  });

  it('falls back to off on an unknown mode and to the default URL on a non-http one, reporting both', () => {
    const c = parseMbmConfig({ MBM_ENABLED: 'yes', MBM_URL: 'mbm:5100' });
    expect(c.mode).toBe('off');
    expect(c.url).toBe('http://mbm:5100');
    expect(c.problems).toHaveLength(2);
  });

  it('reports a missing feed user only when enabled', () => {
    expect(parseMbmConfig({ MBM_ENABLED: 'observe' }).problems).toEqual([expect.stringContaining('MBM_FEED_USER_ID')]);
    expect(parseMbmConfig({}).feedUserId).toBeNull();
    expect(parseMbmConfig({}).problems).toEqual([]);
  });

  it('formats the single boot line', () => {
    const c = parseMbmConfig({ MBM_ENABLED: 'observe', MBM_FEED_USER_ID: 'o' });
    expect(mbmBootLine(c)).toBe('[mbm] mode=observe instruments=NIFTY url=http://mbm:5100 feedUser=o');
  });
});

describe('MBM universe', () => {
  it('NIFTY has the 11 contract series with unique ids', () => {
    const ids = MBM_UNIVERSE.NIFTY.map((s) => s.series);
    expect(ids).toEqual([
      'NIFTY', 'BANKNIFTY', 'INDIAVIX', 'EQ_RELIANCE', 'EQ_HDFCBANK', 'EQ_ICICIBANK',
      'EQ_INFY', 'EQ_TCS', 'EQ_BHARTIARTL', 'EQ_LT', 'EQ_ITC',
    ]);
  });

  it('reports instruments without a universe', () => {
    const u = universeFor(['NIFTY', 'SENSEX']);
    expect(u.series).toHaveLength(11);
    expect(u.unknown).toEqual(['SENSEX']);
  });
});
