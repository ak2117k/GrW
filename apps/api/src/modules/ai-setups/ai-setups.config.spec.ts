import { parseAiSetupsConfig } from './ai-setups.config';

describe('parseAiSetupsConfig', () => {
  it('defaults: off, Opus, 8 s packet, 3 a day, 30 min cooldown, min OI 500', () => {
    expect(parseAiSetupsConfig({})).toEqual({
      mode: 'off',
      model: 'claude-opus-5',
      packetMs: 8000,
      maxPerDay: 3,
      cooldownMin: 30,
      minOi: 500,
    });
  });

  it('reads AI_SETUPS=paper (trimmed, any case)', () => {
    expect(parseAiSetupsConfig({ AI_SETUPS: ' Paper ' }).mode).toBe('paper');
  });

  it('has no live mode: live and junk are off', () => {
    expect(parseAiSetupsConfig({ AI_SETUPS: 'live' }).mode).toBe('off');
    expect(parseAiSetupsConfig({ AI_SETUPS: 'on' }).mode).toBe('off');
  });

  it('reads the model, packet time box and min OI; out-of-range numbers keep the default', () => {
    const c = parseAiSetupsConfig({ AI_SETUP_MODEL: 'claude-opus-5-5', AI_SETUP_PACKET_MS: '5000', AI_SETUP_MIN_OI: '1000' });
    expect(c).toMatchObject({ model: 'claude-opus-5-5', packetMs: 5000, minOi: 1000 });
    expect(parseAiSetupsConfig({ AI_SETUP_PACKET_MS: 'abc', AI_SETUP_MIN_OI: '-3', AI_SETUP_MODEL: '  ' })).toMatchObject({
      packetMs: 8000,
      minOi: 500,
      model: 'claude-opus-5',
    });
  });

  it('the daily cap and cooldown are fixed (not env knobs)', () => {
    expect(parseAiSetupsConfig({ AI_SETUP_MAX_PER_DAY: '10', AI_SETUP_COOLDOWN_MIN: '1' })).toMatchObject({ maxPerDay: 3, cooldownMin: 30 });
  });
});
