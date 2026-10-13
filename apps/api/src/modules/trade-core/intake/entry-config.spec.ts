import { readEntryConfig } from './entry-config';

describe('readEntryConfig (O2)', () => {
  it('defaults to off with nobody; an unknown mode is off (fail closed)', () => {
    expect(readEntryConfig({})).toEqual({ mode: 'off', userIds: new Set(), maxAlertAgeMs: 180_000 });
    expect(readEntryConfig({ CORE_ENTRIES_MODE: 'live' }).mode).toBe('off');
  });

  it('reads journal / paper case-insensitively and a trimmed comma list of users', () => {
    expect(readEntryConfig({ CORE_ENTRIES_MODE: ' Paper ', CORE_ENTRY_USER_IDS: ' u1, ,u2 ' })).toEqual({ mode: 'paper', userIds: new Set(['u1', 'u2']), maxAlertAgeMs: 180_000 });
    expect(readEntryConfig({ CORE_ENTRIES_MODE: 'journal' }).mode).toBe('journal');
  });
});

describe('readEntryConfig — max alert age (review fix 2)', () => {
  it('defaults to 180 s; CORE_ENTRY_MAX_ALERT_AGE_SEC overrides; a non-positive or junk value keeps the default', () => {
    expect(readEntryConfig({}).maxAlertAgeMs).toBe(180_000);
    expect(readEntryConfig({ CORE_ENTRY_MAX_ALERT_AGE_SEC: ' 60 ' }).maxAlertAgeMs).toBe(60_000);
    expect(readEntryConfig({ CORE_ENTRY_MAX_ALERT_AGE_SEC: '0' }).maxAlertAgeMs).toBe(180_000);
    expect(readEntryConfig({ CORE_ENTRY_MAX_ALERT_AGE_SEC: 'soon' }).maxAlertAgeMs).toBe(180_000);
  });
});
