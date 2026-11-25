import { parseMessageReaderConfig } from './message-reader.config';

describe('parseMessageReaderConfig', () => {
  it('defaults to off', () => {
    expect(parseMessageReaderConfig({}).mode).toBe('off');
  });

  it('reads MESSAGE_READER=shadow', () => {
    expect(parseMessageReaderConfig({ MESSAGE_READER: 'shadow' }).mode).toBe('shadow');
    expect(parseMessageReaderConfig({ MESSAGE_READER: ' ON ' }).mode).toBe('on');
  });

  it('an unknown value is off', () => {
    expect(parseMessageReaderConfig({ MESSAGE_READER: 'yes' }).mode).toBe('off');
  });

  it('has the documented defaults', () => {
    expect(parseMessageReaderConfig({})).toEqual({
      mode: 'off',
      model: 'claude-sonnet-5',
      packetMs: 3000,
      timeoutMs: 25000,
      maxAgeMin: 30,
      retryMaxAgeMin: 5,
    });
  });

  it('reads the env overrides and ignores out-of-range numbers', () => {
    const c = parseMessageReaderConfig({
      MESSAGE_READER_MODEL: 'claude-opus-5-5',
      MESSAGE_READER_PACKET_MS: '1500',
      MESSAGE_READER_TIMEOUT_MS: 'abc',
      MESSAGE_READER_MAX_AGE_MIN: '-4',
    });
    expect(c.model).toBe('claude-opus-5-5');
    expect(c.packetMs).toBe(1500);
    expect(c.timeoutMs).toBe(25000);
    expect(c.maxAgeMin).toBe(30);
  });
});
