import { mbmBootLine, mbmEntryGateMode, parseMbmConfig } from './mbm.config';
import { MBM_UNIVERSE, universeFor } from './mbm-universe';

describe('parseMbmConfig', () => {
  it('defaults to off / NIFTY / http://mbm:5100 / first auto-exit user', () => {
    const c = parseMbmConfig({ AI_AUTO_EXIT_USER_IDS: ' u1 , u2' });
    expect(c).toEqual({ mode: 'off', instruments: ['NIFTY'], url: 'http://mbm:5100', feedUserId: 'u1', packet: 'off', exitShadow: 'off', entryGate: 'off', chainCapture: 'off', chainCaptureStocks: 'off', chainCaptureInstruments: ['NIFTY', 'BANKNIFTY'], tickBars: 'listen', problems: [] });
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

  describe('M3 consumer flags (MBM_PACKET, MBM_EXIT_SHADOW)', () => {
    const on = { MBM_ENABLED: 'observe', MBM_FEED_USER_ID: 'o' };
    it.each(['off', 'observe', 'on'] as const)('parses %s for both flags', (m) => {
      const c = parseMbmConfig({ ...on, MBM_PACKET: ` ${m.toUpperCase()} `, MBM_EXIT_SHADOW: m });
      expect([c.packet, c.exitShadow]).toEqual([m, m]);
      expect(c.problems).toEqual([]);
    });
    it('defaults both to off', () => {
      const c = parseMbmConfig(on);
      expect([c.packet, c.exitShadow]).toEqual(['off', 'off']);
    });
    it('an unknown value falls back to off and is reported', () => {
      const c = parseMbmConfig({ ...on, MBM_PACKET: 'yes', MBM_EXIT_SHADOW: 'true' });
      expect([c.packet, c.exitShadow]).toEqual(['off', 'off']);
      expect(c.problems).toEqual([expect.stringContaining('MBM_PACKET=yes'), expect.stringContaining('MBM_EXIT_SHADOW=true')]);
    });
    it('MBM_ENABLED=off forces both off (the global rule) and says so', () => {
      const c = parseMbmConfig({ MBM_PACKET: 'on', MBM_EXIT_SHADOW: 'observe' });
      expect([c.packet, c.exitShadow]).toEqual(['off', 'off']);
      expect(c.problems).toEqual([
        expect.stringContaining('MBM_PACKET=on is ignored'),
        expect.stringContaining('MBM_EXIT_SHADOW=observe is ignored'),
      ]);
    });
  });

  it('parses MBM_ENTRY_GATE (off|observe|on, default off) and reports an unknown value', () => {
    expect(parseMbmConfig({ MBM_ENTRY_GATE: ' Observe ' }).entryGate).toBe('observe');
    expect(parseMbmConfig({ MBM_ENTRY_GATE: 'on' }).entryGate).toBe('on');
    const bad = parseMbmConfig({ MBM_ENTRY_GATE: 'true' });
    expect(bad.entryGate).toBe('off');
    expect(bad.problems).toEqual([expect.stringContaining('MBM_ENTRY_GATE=true')]);
  });

  it('the entry gate is inert while MBM_ENABLED=off', () => {
    expect(mbmEntryGateMode(parseMbmConfig({ MBM_ENTRY_GATE: 'on' }))).toBe('off');
    expect(mbmEntryGateMode(parseMbmConfig({ MBM_ENABLED: 'observe', MBM_ENTRY_GATE: 'on', MBM_FEED_USER_ID: 'o' }))).toBe('on');
    expect(mbmEntryGateMode(null)).toBe('off');
  });

  it('formats the single boot line', () => {
    const c = parseMbmConfig({ MBM_ENABLED: 'observe', MBM_FEED_USER_ID: 'o' });
    expect(mbmBootLine(c)).toBe('[mbm] mode=observe instruments=NIFTY url=http://mbm:5100 feedUser=o chainCapture=off chainCaptureStocks=off tickBars=listen');
    expect(mbmBootLine(parseMbmConfig({ MBM_CHAIN_CAPTURE: 'on', MBM_FEED_USER_ID: 'o' }))).toContain('chainCapture=on');
  });

  it('parses MBM_CHAIN_CAPTURE: default off, on/off case-insensitive, independent of MBM_ENABLED', () => {
    expect(parseMbmConfig({}).chainCapture).toBe('off');
    expect(parseMbmConfig({ MBM_CHAIN_CAPTURE: ' ON ', MBM_FEED_USER_ID: 'o' }).chainCapture).toBe('on');
    expect(parseMbmConfig({ MBM_CHAIN_CAPTURE: 'off' }).chainCapture).toBe('off');
    const c = parseMbmConfig({ MBM_ENABLED: 'off', MBM_CHAIN_CAPTURE: 'on', MBM_FEED_USER_ID: 'o' });
    expect(c.chainCapture).toBe('on');
    expect(c.problems).toEqual([]);
  });

  it('a bad MBM_CHAIN_CAPTURE falls back to off; on without a feed user is reported', () => {
    const bad = parseMbmConfig({ MBM_CHAIN_CAPTURE: 'observe', MBM_FEED_USER_ID: 'o' });
    expect(bad.chainCapture).toBe('off');
    expect(bad.problems).toEqual(['MBM_CHAIN_CAPTURE=observe is not off|on — using off']);
    const noUser = parseMbmConfig({ MBM_CHAIN_CAPTURE: 'on' });
    expect(noUser.chainCapture).toBe('on');
    expect(noUser.problems.join()).toMatch(/chain capture will not run/);
  });

  it('parses MBM_CHAIN_CAPTURE_STOCKS: default off, independent of MBM_ENABLED / MBM_CHAIN_CAPTURE, bad → off', () => {
    expect(parseMbmConfig({}).chainCaptureStocks).toBe('off');
    const on = parseMbmConfig({ MBM_CHAIN_CAPTURE_STOCKS: ' On ', MBM_FEED_USER_ID: 'o' });
    expect(on.chainCaptureStocks).toBe('on');
    expect(on.chainCapture).toBe('off');
    expect(on.problems).toEqual([]);
    const bad = parseMbmConfig({ MBM_CHAIN_CAPTURE_STOCKS: 'yes', MBM_FEED_USER_ID: 'o' });
    expect(bad.chainCaptureStocks).toBe('off');
    expect(bad.problems).toEqual(['MBM_CHAIN_CAPTURE_STOCKS=yes is not off|on — using off']);
    expect(parseMbmConfig({ MBM_CHAIN_CAPTURE_STOCKS: 'on' }).problems.join()).toMatch(/per-symbol chain capture will not run/);
  });

  it('parses MBM_CHAIN_CAPTURE_INSTRUMENTS: default NIFTY,BANKNIFTY; unknown names ignored with a problem', () => {
    expect(parseMbmConfig({}).chainCaptureInstruments).toEqual(['NIFTY', 'BANKNIFTY']);
    expect(parseMbmConfig({ MBM_CHAIN_CAPTURE_INSTRUMENTS: ' nifty ' }).chainCaptureInstruments).toEqual(['NIFTY']);
    const bad = parseMbmConfig({ MBM_CHAIN_CAPTURE_INSTRUMENTS: 'FINNIFTY,banknifty' });
    expect(bad.chainCaptureInstruments).toEqual(['BANKNIFTY']);
    expect(bad.problems).toEqual(['MBM_CHAIN_CAPTURE_INSTRUMENTS: FINNIFTY is not one of NIFTY|BANKNIFTY — ignored']);
    expect(parseMbmConfig({ MBM_CHAIN_CAPTURE_INSTRUMENTS: 'X' }).chainCaptureInstruments).toEqual(['NIFTY', 'BANKNIFTY']);
    expect(mbmBootLine(parseMbmConfig({ MBM_CHAIN_CAPTURE: 'on', MBM_FEED_USER_ID: 'o' }))).toContain('chainCapture=on(NIFTY,BANKNIFTY)');
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

  it('puts the priority series (NIFTY, INDIAVIX) first, the rest in contract order', () => {
    expect(universeFor(['NIFTY']).series.map((s) => s.series).slice(0, 4)).toEqual(['NIFTY', 'INDIAVIX', 'BANKNIFTY', 'EQ_RELIANCE']);
  });
});
