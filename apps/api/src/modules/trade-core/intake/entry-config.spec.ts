import { readEntryConfig } from './entry-config';

describe('readEntryConfig (O2)', () => {
  it('defaults to off with nobody; an unknown mode is off (fail closed)', () => {
    expect(readEntryConfig({})).toEqual({ mode: 'off', userIds: new Set() });
    expect(readEntryConfig({ CORE_ENTRIES_MODE: 'live' }).mode).toBe('off');
  });

  it('reads journal / paper case-insensitively and a trimmed comma list of users', () => {
    expect(readEntryConfig({ CORE_ENTRIES_MODE: ' Paper ', CORE_ENTRY_USER_IDS: ' u1, ,u2 ' })).toEqual({ mode: 'paper', userIds: new Set(['u1', 'u2']) });
    expect(readEntryConfig({ CORE_ENTRIES_MODE: 'journal' }).mode).toBe('journal');
  });
});
