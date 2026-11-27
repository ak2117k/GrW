import { Logger } from '@nestjs/common';
import { TRACKER_WAKE } from './exit-authority.tokens';
import { LATE_PORT, LateBinding, lateBindingOf, lateOwnerExit, lateTrackerWake, PortUnboundError } from './late-ports';

/** ModuleRef.get(token, { strict: false, each: true }) over a fixed registry. */
const refOver = (registry: Map<unknown, unknown[]>) => ({
  get: jest.fn((token: unknown) => {
    const found = registry.get(token);
    if (!found || found.length === 0) throw new Error('UnknownElementException');
    return found;
  }),
});

describe('late-bound exit-authority ports', () => {
  afterEach(() => jest.restoreAllMocks());

  it('resolves the REAL instance registered under the same token, skipping the forwarders, and caches it', () => {
    const registry = new Map<unknown, unknown[]>();
    const ref = refOver(registry);
    const fwd = lateTrackerWake(ref as never);
    const real = { wakeTracker: jest.fn() };
    registry.set(TRACKER_WAKE, [fwd, real]);
    fwd.wakeTracker('u', 't', 'why');
    fwd.wakeTracker('u', 't2', 'why');
    expect(real.wakeTracker.mock.calls).toEqual([['u', 't', 'why'], ['u', 't2', 'why']]);
    expect(ref.get).toHaveBeenCalledTimes(1);
    expect(lateBindingOf(fwd)?.resolve()).toBe(real);
    expect(lateBindingOf(real)).toBeNull();
    expect((fwd as unknown as Record<symbol, unknown>)[LATE_PORT]).toBeInstanceOf(LateBinding);
  });

  it('unbound (only forwarders, or nothing): every call throws PortUnboundError and ERROR is logged once', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const registry = new Map<unknown, unknown[]>();
    const fwd = lateOwnerExit(refOver(registry) as never);
    await expect(Promise.resolve().then(() => fwd.exitAsOwner('u', 't', 'BACKSTOP HARD_LOSS: x'))).rejects.toBeInstanceOf(PortUnboundError);
    expect(() => fwd.exitAsOwner('u', 't', 'x')).toThrow('[exit-authority] OWNER_EXIT is not bound in this process');
    expect(error).toHaveBeenCalledTimes(1);
    expect(lateBindingOf(fwd)?.resolve()).toBeNull();
  });

  it('a binding that appears later (after boot) is picked up on the next call', () => {
    const registry = new Map<unknown, unknown[]>();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const fwd = lateTrackerWake(refOver(registry) as never);
    expect(() => fwd.wakeTracker('u', 't', 'w')).toThrow(PortUnboundError);
    const real = { wakeTracker: jest.fn() };
    registry.set(TRACKER_WAKE, [fwd, real]);
    fwd.wakeTracker('u', 't', 'w');
    expect(real.wakeTracker).toHaveBeenCalledTimes(1);
  });
});
