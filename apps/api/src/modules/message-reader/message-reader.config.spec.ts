import { parseMessageReaderConfig, readerConcurrencyWarning } from './message-reader.config';

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
      maxInFlight: 8,
      maxInstrumentBuilds: 2,
      skipStructure: true,
      agentsGlobalConcurrency: 16,
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

  it('reads the in-flight, instrument-build and skip-structure knobs', () => {
    const c = parseMessageReaderConfig({
      MESSAGE_READER_MAX_IN_FLIGHT: '3',
      MESSAGE_READER_MAX_INSTRUMENT_BUILDS: '4',
      MESSAGE_READER_SKIP_STRUCTURE: 'false',
      AGENTS_GLOBAL_CONCURRENCY: '30',
    });
    expect(c).toMatchObject({ maxInFlight: 3, maxInstrumentBuilds: 4, skipStructure: false, agentsGlobalConcurrency: 30 });
    expect(parseMessageReaderConfig({ MESSAGE_READER_MAX_IN_FLIGHT: '0', MESSAGE_READER_SKIP_STRUCTURE: 'maybe' })).toMatchObject({ maxInFlight: 8, skipStructure: true });
  });

  it('warns when the reader is on with AGENTS_GLOBAL_CONCURRENCY < 24, never when off', () => {
    expect(readerConcurrencyWarning(parseMessageReaderConfig({ MESSAGE_READER: 'shadow' }))).toContain('AGENTS_GLOBAL_CONCURRENCY=16');
    expect(readerConcurrencyWarning(parseMessageReaderConfig({ MESSAGE_READER: 'on', AGENTS_GLOBAL_CONCURRENCY: '24' }))).toBeNull();
    expect(readerConcurrencyWarning(parseMessageReaderConfig({}))).toBeNull();
  });
});
