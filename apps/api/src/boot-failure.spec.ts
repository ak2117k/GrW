import { exitOnBootFailure } from './boot-failure';

/**
 * A boot that fails must EXIT, not linger.
 *
 * `main.ts` registers a `process.on('unhandledRejection')` handler, which since
 * Node 15 suppresses the default behaviour of killing the process. That handler
 * logs and returns. `bootstrap()` was then invoked with no `.catch`, so any
 * rejection from it — a failed database connect being the live example — was
 * logged and ignored.
 *
 * The result was the worst available outcome: a process that is alive, holds
 * open handles from half-initialised modules (an orphaned broker WebSocket kept
 * logging long after boot had died), and never calls `listen()`. Render can only
 * observe "no open ports detected", which is four layers removed from the real
 * cause and sent three separate investigations after the port instead of the
 * database.
 *
 * Exiting non-zero puts the real error in the deploy log and lets the platform
 * restart the container, which is what every layer above expects a failed boot
 * to look like.
 */
describe('exitOnBootFailure', () => {
  it('exits non-zero so a failed boot cannot masquerade as a port problem', () => {
    const exit = jest.fn();
    const error = jest.fn();

    exitOnBootFailure(new Error('Can\'t reach database server'), { error, exit });

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('logs the underlying error, not a summary of it', () => {
    const exit = jest.fn();
    const error = jest.fn();
    const cause = new Error('P1001: database unreachable');

    exitOnBootFailure(cause, { error, exit });

    // The deploy log is the only place this is ever read, so the original error
    // object goes in whole — a stringified summary loses the stack that names
    // which module's hook rejected.
    expect(error).toHaveBeenCalledWith(expect.stringContaining('failed to start'), cause);
  });

  it('handles a non-Error rejection without throwing on the way out', () => {
    const exit = jest.fn();
    const error = jest.fn();

    expect(() => exitOnBootFailure('a bare string', { error, exit })).not.toThrow();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
