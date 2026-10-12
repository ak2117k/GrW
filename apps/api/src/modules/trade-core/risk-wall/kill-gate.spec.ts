import { Logger } from '@nestjs/common';
import {
  assertCoreEntryAllowed,
  coreEntryAllowed,
  CoreKillSwitchEntryBlockedError,
  invalidateCoreKillSwitchCache,
  setCoreKillSwitchReader,
  type KillSwitchReadPort,
} from './kill-gate';

const reader = (over: Partial<KillSwitchReadPort> = {}): KillSwitchReadPort & { [k: string]: jest.Mock } =>
  ({ isOn: jest.fn(async () => false), isOnForPlatform: jest.fn(async () => false), invalidate: jest.fn(), ...over }) as never;
const OFF = reader();

let warn: jest.SpyInstance;
beforeEach(() => { warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined); });
afterEach(() => { warn.mockRestore(); setCoreKillSwitchReader(OFF); });

describe('kill-gate', () => {
  it('allows an entry while the switch is off, without logging', async () => {
    const r = reader();
    setCoreKillSwitchReader(r);
    expect(await coreEntryAllowed('ungated-track', { ref: 'RELIANCE' })).toBe(true);
    expect(r.isOnForPlatform).toHaveBeenCalledTimes(1);
    expect(r.isOn).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses while the owner switch is on, and logs it', async () => {
    setCoreKillSwitchReader(reader({ isOnForPlatform: jest.fn(async () => true) }));
    expect(await coreEntryAllowed('breakout-swing-track', { ref: 'TCS' })).toBe(false);
    expect(String(warn.mock.calls[0][0])).toBe('[breakout-swing-track] new entry TCS refused: the core kill switch is on');
  });

  it('a per-user entry asks about that user only', async () => {
    const r = reader({ isOn: jest.fn(async (u: string) => u === 'user_A') });
    setCoreKillSwitchReader(r);
    expect(await coreEntryAllowed('auto-execution', { userId: 'user_A', ref: 'NIFTY' })).toBe(false);
    expect(await coreEntryAllowed('auto-execution', { userId: 'user_B', ref: 'NIFTY' })).toBe(true);
    expect(r.isOnForPlatform).not.toHaveBeenCalled();
  });

  it('fails closed when the state cannot be read, or no reader is wired', async () => {
    setCoreKillSwitchReader(reader({ isOnForPlatform: jest.fn(async () => { throw new Error('db down'); }) }));
    expect(await coreEntryAllowed('sell-futures-track')).toBe(false);
    expect(String(warn.mock.calls[0][0])).toContain('cannot be read (db down); failing closed');
    setCoreKillSwitchReader(null);
    expect(await coreEntryAllowed('watch-monitor')).toBe(false);
    expect(String(warn.mock.calls[1][0])).toContain('reader is not wired');
  });

  it('assertCoreEntryAllowed throws a named error only when refused', async () => {
    setCoreKillSwitchReader(reader({ isOnForPlatform: jest.fn(async () => true) }));
    const err = await assertCoreEntryAllowed('adaptive-stop-track', { ref: 'INFY' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoreKillSwitchEntryBlockedError);
    expect(err).toMatchObject({ entry: 'adaptive-stop-track', ref: 'INFY', message: 'adaptive-stop-track: new entry INFY refused (core kill switch)' });
    setCoreKillSwitchReader(OFF);
    await expect(assertCoreEntryAllowed('adaptive-stop-track', { ref: 'INFY' })).resolves.toBeUndefined();
  });

  it('a late re-check (just before opening) says so in its one refusal line, and throws the same error', async () => {
    setCoreKillSwitchReader(reader({ isOnForPlatform: jest.fn(async () => true) }));
    const err = await assertCoreEntryAllowed('ungated-track', { ref: 'INFY', recheck: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoreKillSwitchEntryBlockedError);
    expect(err).toMatchObject({ entry: 'ungated-track', ref: 'INFY' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toBe(
      '[ungated-track] new entry INFY refused at the re-check just before opening (engaged while the entry was being prepared): the core kill switch is on',
    );
  });

  it('invalidate reaches the registered reader, and is safe with none', () => {
    const r = reader();
    setCoreKillSwitchReader(r);
    invalidateCoreKillSwitchCache();
    expect(r.invalidate).toHaveBeenCalledTimes(1);
    setCoreKillSwitchReader(null);
    expect(() => invalidateCoreKillSwitchCache()).not.toThrow();
  });
});
