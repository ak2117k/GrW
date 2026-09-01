import { UniverseScannerWorker } from '../../modules/signal-generator/workers/universe-scanner.worker';
import { PositionManagerService } from '../../modules/trade-engine/services/position-manager.service';
import { AdaptiveStopAccountService } from '../../modules/adaptive-stop-track/services/adaptive-stop-account.service';
import { SellFuturesPaperAccountService } from '../../modules/sell-futures-track/services/sell-futures-paper-account.service';
import { UngatedPaperAccountService } from '../../modules/ungated-track/services/ungated-paper-account.service';

/**
 * The regression net for a whole class of outage.
 *
 * Nest runs `onModuleInit` hooks concurrently under `Promise.all`, inside
 * `app.listen()`. One unguarded rejection aborts the batch, `init()` rejects,
 * and the port is never bound — so the platform reports "no open ports
 * detected" and a database outage presents as a port bug. That cost four failed
 * deploys.
 *
 * Each case below constructs a service with a database that rejects EVERY call,
 * which is what an unreachable Neon actually looks like, and asserts the hook
 * still resolves. A new boot hook that queries without a guard fails here rather
 * than in production.
 *
 * This is a behavioural check, not a lint: it proves the hook survives, not
 * merely that a `try` appears somewhere in the file.
 */
const DEAD_DB_ERROR = new Error(
  "Can't reach database server at `ep-hidden-pine.aws.neon.tech:5432`\nPlease make sure...",
);

/** Every property is a method that rejects — an unreachable database. */
const deadDatabase = (): any =>
  new Proxy(
    {},
    {
      get: () =>
        new Proxy({}, { get: () => jest.fn().mockRejectedValue(DEAD_DB_ERROR) }),
    },
  );

/** Every method rejects — for repositories and collaborators. */
const deadCollaborator = (): any =>
  new Proxy({}, { get: () => jest.fn().mockRejectedValue(DEAD_DB_ERROR) });

describe('boot hooks survive a database outage', () => {
  beforeEach(() => {
    // These hooks log the skip; keep the suite output readable without hiding
    // that the log happens (asserted in survive-boot-work.spec.ts).
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('UniverseScannerWorker resolves when instrument lookup fails', async () => {
    const worker = new UniverseScannerWorker(
      deadDatabase(),
      deadCollaborator(),
      deadCollaborator(),
      deadCollaborator(),
      deadCollaborator(),
      deadCollaborator(),
      deadCollaborator(),
      deadCollaborator(),
    );

    await expect(worker.onModuleInit()).resolves.toBeUndefined();
  });

  it('PositionManagerService resolves when open positions cannot be read', async () => {
    const service = new PositionManagerService(deadCollaborator(), deadCollaborator());

    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });

  it('AdaptiveStopAccountService resolves when the account cannot be read', async () => {
    const service = new AdaptiveStopAccountService(deadDatabase(), deadCollaborator());

    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });

  it('SellFuturesPaperAccountService resolves when the account cannot be read', async () => {
    const service = new SellFuturesPaperAccountService(deadDatabase(), deadCollaborator());

    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });

  it('UngatedPaperAccountService resolves when the account cannot be read', async () => {
    const service = new UngatedPaperAccountService(deadDatabase(), deadCollaborator());

    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });
});
