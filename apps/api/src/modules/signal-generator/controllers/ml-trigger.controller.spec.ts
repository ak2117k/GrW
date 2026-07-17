import { UnauthorizedException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { MlTriggerController } from './ml-trigger.controller';

/**
 * The ML data-capture ops triggers. These are what actually cause Phase 1 to
 * produce a training set — nothing else calls the backfill or the resolver.
 *
 * They live on a @Public() controller because the external heartbeat that
 * drives them (cron-job.org / UptimeRobot — the free tier idles the in-process
 * scheduler out) cannot present a Bearer JWT. Auth is therefore a constant-time
 * path-secret check against ML_TRIGGER_SECRET, and these tests are the only
 * thing standing between that endpoint and the open internet — hence the
 * dedicated auth-boundary block below, including the fail-CLOSED case.
 */
describe('MlTriggerController', () => {
  const TARGET = { token: '2885', exchange: 'NSE', symbol: 'RELIANCE' };
  const SECRET = 'k7Hn3Fp9q2X-correct-horse-battery-staple-32chars';

  function build(overrides: Partial<any> = {}) {
    const deps = {
      config: {
        get: jest.fn((k: string) => (k === 'ML_TRIGGER_SECRET' ? SECRET : null)),
      },
      patternBackfill: {
        isRunning: false,
        run: jest.fn().mockResolvedValue([
          { target: 'RELIANCE', timeframe: '15m', observations: 4 },
          { target: 'RELIANCE', timeframe: '1h', observations: 3 },
        ]),
      },
      patternCapture: { resolvePending: jest.fn().mockResolvedValue(7) },
      patternScan: {
        scan: jest.fn().mockResolvedValue([
          { target: 'RELIANCE', timeframe: '15m', observations: 1 },
        ]),
      },
      ...overrides,
    };
    const ctrl = new MlTriggerController(
      deps.config as never,
      deps.patternBackfill as never,
      deps.patternCapture as never,
      deps.patternScan as never,
    );
    return { ctrl, deps };
  }

  /**
   * The secret travels in a HEADER, never the URL.
   *
   * This is a property of the route's SHAPE, not its behaviour, so no functional
   * test can defend it: re-add `:secret` to a path and every other test in this
   * file still passes while the secret starts leaking into the access logs, the
   * global LoggingInterceptor, and every 404 the exception filter reports. The
   * metadata is what Nest actually hands to Express, so asserting on it checks
   * the real thing rather than a proxy for it.
   */
  describe('route shape', () => {
    it.each([
      ['triggerPatternBackfill', 'backfill'],
      ['triggerResolvePending', 'resolve-pending'],
    ])('%s is a static route with no path param', (method, expected) => {
      const path = Reflect.getMetadata(
        PATH_METADATA,
        (MlTriggerController.prototype as never)[method],
      );
      expect(path).toBe(expected);
      // `:` is the only way a secret gets back into the URL.
      expect(path).not.toContain(':');
    });

    it('is mounted at webhooks/ml', () => {
      expect(Reflect.getMetadata(PATH_METADATA, MlTriggerController)).toBe('webhooks/ml');
    });
  });

  /**
   * THE auth boundary. Every one of these must fail if the guard is weakened —
   * see the mutation notes in the fix report.
   */
  describe('auth (ML_TRIGGER_SECRET header)', () => {
    it('accepts the correct secret', async () => {
      const { ctrl, deps } = build();
      const res = await ctrl.triggerPatternBackfill(SECRET, { targets: [TARGET] });
      expect(res).toEqual({ accepted: true, targets: 1 });
      expect(deps.patternBackfill.run).toHaveBeenCalled();
    });

    it('rejects a WRONG secret with 401 and never calls the service', async () => {
      const { ctrl, deps } = build();
      await expect(
        ctrl.triggerPatternBackfill('wrong-secret', { targets: [TARGET] }),
      ).rejects.toThrow(UnauthorizedException);
      expect(deps.patternBackfill.run).not.toHaveBeenCalled();
    });

    // A same-length wrong secret defeats the length pre-check and exercises the
    // timingSafeEqual comparison itself.
    it('rejects a same-length wrong secret with 401', async () => {
      const { ctrl, deps } = build();
      const sameLength = 'X'.repeat(SECRET.length);
      expect(sameLength).toHaveLength(SECRET.length);
      await expect(
        ctrl.triggerPatternBackfill(sameLength, { targets: [TARGET] }),
      ).rejects.toThrow(UnauthorizedException);
      expect(deps.patternBackfill.run).not.toHaveBeenCalled();
    });

    it('rejects an empty secret with 401', async () => {
      const { ctrl, deps } = build();
      await expect(
        ctrl.triggerPatternBackfill('', { targets: [TARGET] }),
      ).rejects.toThrow(UnauthorizedException);
      expect(deps.patternBackfill.run).not.toHaveBeenCalled();
    });

    // New failure mode created by the move to a header: a path param always
    // arrived as a string, but an absent header arrives as `undefined`. It must
    // 401 like any other bad secret — not crash reading `.length` off undefined,
    // which would surface as a 500 and leak a stack trace.
    it.each([
      ['a missing header', undefined],
      ['a null header', null],
    ])('rejects %s with 401 rather than throwing a 500', async (_label, provided) => {
      const { ctrl, deps } = build();
      await expect(
        ctrl.triggerPatternBackfill(provided as never, { targets: [TARGET] }),
      ).rejects.toThrow(UnauthorizedException);
      await expect(ctrl.triggerResolvePending(provided as never, {})).rejects.toThrow(
        UnauthorizedException,
      );
      expect(deps.patternBackfill.run).not.toHaveBeenCalled();
      expect(deps.patternCapture.resolvePending).not.toHaveBeenCalled();
    });

    // THE most important test here. An unconfigured secret must reject
    // everything — falling open would leave an ops endpoint that burns broker
    // quota and writes the shared training set exposed to the open internet.
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['empty string', ''],
    ])(
      'FAILS CLOSED when ML_TRIGGER_SECRET is %s — does not fall open',
      async (_label, configured) => {
        const { ctrl, deps } = build({
          config: { get: jest.fn().mockReturnValue(configured) },
        });
        // Even the "right" secret cannot get in when none is configured.
        await expect(
          ctrl.triggerPatternBackfill(SECRET, { targets: [TARGET] }),
        ).rejects.toThrow(UnauthorizedException);
        await expect(
          ctrl.triggerResolvePending(SECRET, {}),
        ).rejects.toThrow(UnauthorizedException);
        // And neither does an empty one (the classic ''===''/undefined-match bug).
        await expect(
          ctrl.triggerPatternBackfill('', { targets: [TARGET] }),
        ).rejects.toThrow(UnauthorizedException);
        expect(deps.patternBackfill.run).not.toHaveBeenCalled();
        expect(deps.patternCapture.resolvePending).not.toHaveBeenCalled();
      },
    );

    it('guards resolve-pending with the same secret', async () => {
      const { ctrl, deps } = build();
      await expect(ctrl.triggerResolvePending('wrong', {})).rejects.toThrow(
        UnauthorizedException,
      );
      expect(deps.patternCapture.resolvePending).not.toHaveBeenCalled();
      await expect(ctrl.triggerResolvePending(SECRET, {})).resolves.toEqual({
        ok: true,
        resolved: 7,
      });
    });

    it('checks auth BEFORE validating the body (no oracle for unauthorized callers)', async () => {
      const { ctrl } = build();
      // An empty-targets body would 400 if it got past auth; it must 401 instead.
      await expect(ctrl.triggerPatternBackfill('wrong', { targets: [] })).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('reads the secret from ML_TRIGGER_SECRET', async () => {
      const { ctrl, deps } = build();
      await ctrl.triggerPatternBackfill(SECRET, { targets: [TARGET] });
      expect(deps.config.get).toHaveBeenCalledWith('ML_TRIGGER_SECRET');
    });

    // The secret must never reach the logs — logs ship to a third party and
    // this value is the entire auth boundary.
    it('never logs the secret (wrong, correct, or unconfigured paths)', async () => {
      const emitted: string[] = [];
      const sinks = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((lvl) =>
        jest
          .spyOn(require('@nestjs/common').Logger.prototype, lvl)
          .mockImplementation((...args: any[]) => {
            emitted.push(args.map((a) => String(a)).join(' '));
          }),
      );

      try {
        const { ctrl } = build();
        await ctrl.triggerPatternBackfill(SECRET, { targets: [TARGET] });
        await expect(
          ctrl.triggerPatternBackfill('a-wrong-but-secret-looking-value', { targets: [TARGET] }),
        ).rejects.toThrow(UnauthorizedException);

        const { ctrl: unconfigured } = build({ config: { get: () => null } });
        await expect(
          unconfigured.triggerPatternBackfill(SECRET, { targets: [TARGET] }),
        ).rejects.toThrow(UnauthorizedException);

        const all = emitted.join('\n');
        expect(all).not.toContain(SECRET);
        expect(all).not.toContain('a-wrong-but-secret-looking-value');
        // The unconfigured path must still say something actionable.
        expect(all).toContain('ML_TRIGGER_SECRET is not configured');
      } finally {
        sinks.forEach((s) => s.mockRestore());
      }
    });
  });

  describe('triggerPatternBackfill', () => {
    it('starts the backfill for the posted targets and accepts immediately', async () => {
      const { ctrl, deps } = build();
      const res = await ctrl.triggerPatternBackfill(SECRET, { targets: [TARGET] });
      expect(deps.patternBackfill.run).toHaveBeenCalledWith([TARGET], {
        timeframes: undefined,
        lookbackDays: undefined,
      });
      expect(res).toEqual({ accepted: true, targets: 1 });
    });

    // The pass is ~527 serialized broker calls (~5-7 min) — far past the
    // ~30-60s timeout of the heartbeats that drive this. The handler must
    // return on its own tick rather than awaiting the run.
    it('returns WITHOUT awaiting the run', async () => {
      let finished = false;
      const { ctrl } = build({
        patternBackfill: {
          isRunning: false,
          run: jest.fn().mockImplementation(
            () =>
              new Promise((resolve) =>
                setTimeout(() => {
                  finished = true;
                  resolve([]);
                }, 50),
              ),
          ),
        },
      });

      const res = await ctrl.triggerPatternBackfill(SECRET, { targets: [TARGET] });

      // Handler resolved while the run is still in flight.
      expect(res).toEqual({ accepted: true, targets: 1 });
      expect(finished).toBe(false);
    });

    it('reports a refusal instead of stacking a second run when one is in flight', async () => {
      const { ctrl, deps } = build({
        patternBackfill: { isRunning: true, run: jest.fn() },
      });

      const res = await ctrl.triggerPatternBackfill(SECRET, { targets: [TARGET] });

      expect(res).toEqual(expect.objectContaining({ accepted: false }));
      expect(deps.patternBackfill.run).not.toHaveBeenCalled();
    });

    // A detached promise that rejects with no .catch() can take the process
    // down. The handler must still accept, and must not reject.
    it('does not reject when the detached run fails', async () => {
      const { ctrl } = build({
        patternBackfill: {
          isRunning: false,
          run: jest.fn().mockRejectedValue(new Error('angel down')),
        },
      });

      await expect(
        ctrl.triggerPatternBackfill(SECRET, { targets: [TARGET] }),
      ).resolves.toEqual({ accepted: true, targets: 1 });
      // Let the rejected detached promise settle — an unhandled rejection here
      // would surface as a process warning/failure rather than being swallowed.
      await new Promise((r) => setImmediate(r));
    });

    it('passes timeframes and lookbackDays through', async () => {
      const { ctrl, deps } = build();
      await ctrl.triggerPatternBackfill(SECRET, {
        targets: [TARGET],
        timeframes: ['15m'],
        lookbackDays: 30,
      });
      expect(deps.patternBackfill.run).toHaveBeenCalledWith([TARGET], {
        timeframes: ['15m'],
        lookbackDays: 30,
      });
    });

    it.each([
      ['missing body', {}],
      ['empty targets', { targets: [] }],
    ])('rejects %s with 400 and never calls the service', async (_label, body) => {
      const { ctrl, deps } = build();
      await expect(ctrl.triggerPatternBackfill(SECRET, body)).rejects.toMatchObject({
        status: 400,
      });
      expect(deps.patternBackfill.run).not.toHaveBeenCalled();
    });

    it('rejects a target missing token/exchange/symbol with 400', async () => {
      const { ctrl, deps } = build();
      await expect(
        ctrl.triggerPatternBackfill(SECRET, { targets: [{ token: '2885' } as never] }),
      ).rejects.toMatchObject({ status: 400 });
      expect(deps.patternBackfill.run).not.toHaveBeenCalled();
    });

    it('503s when the backfill service is not wired', async () => {
      const { ctrl } = build({ patternBackfill: undefined });
      await expect(
        ctrl.triggerPatternBackfill(SECRET, { targets: [TARGET] }),
      ).rejects.toMatchObject({ status: 503 });
    });
  });

  describe('triggerResolvePending', () => {
    it('resolves pending rows and returns the count', async () => {
      const { ctrl, deps } = build();
      const res = await ctrl.triggerResolvePending(SECRET, {});
      expect(deps.patternCapture.resolvePending).toHaveBeenCalledWith(undefined);
      expect(res).toEqual({ ok: true, resolved: 7 });
    });

    it('passes an explicit limit through', async () => {
      const { ctrl, deps } = build();
      await ctrl.triggerResolvePending(SECRET, { limit: 25 });
      expect(deps.patternCapture.resolvePending).toHaveBeenCalledWith(25);
    });

    it('503s when the capture service is not wired', async () => {
      const { ctrl } = build({ patternCapture: undefined });
      await expect(ctrl.triggerResolvePending(SECRET, {})).rejects.toMatchObject({
        status: 503,
      });
    });
  });

  describe('triggerScan', () => {
    it('scans the posted targets and returns the per-target results', async () => {
      const { ctrl, deps } = build();
      const res = await ctrl.triggerScan(SECRET, { targets: [TARGET] });
      expect(deps.patternScan.scan).toHaveBeenCalledWith([TARGET], {
        timeframes: undefined,
        lookbackDays: undefined,
      });
      expect(res).toEqual({
        ok: true,
        results: [{ target: 'RELIANCE', timeframe: '15m', observations: 1 }],
      });
    });

    it('passes timeframes and lookbackDays through', async () => {
      const { ctrl, deps } = build();
      await ctrl.triggerScan(SECRET, { targets: [TARGET], timeframes: ['15m'], lookbackDays: 5 });
      expect(deps.patternScan.scan).toHaveBeenCalledWith([TARGET], {
        timeframes: ['15m'],
        lookbackDays: 5,
      });
    });

    it('rejects a WRONG secret with 401 and never scans', async () => {
      const { ctrl, deps } = build();
      await expect(ctrl.triggerScan('wrong', { targets: [TARGET] })).rejects.toThrow(
        UnauthorizedException,
      );
      expect(deps.patternScan.scan).not.toHaveBeenCalled();
    });

    it.each([
      ['missing body', {}],
      ['empty targets', { targets: [] }],
    ])('rejects %s with 400 and never scans', async (_label, body) => {
      const { ctrl, deps } = build();
      await expect(ctrl.triggerScan(SECRET, body)).rejects.toMatchObject({ status: 400 });
      expect(deps.patternScan.scan).not.toHaveBeenCalled();
    });

    it('rejects a target missing token/exchange/symbol with 400', async () => {
      const { ctrl, deps } = build();
      await expect(
        ctrl.triggerScan(SECRET, { targets: [{ token: '2885' } as never] }),
      ).rejects.toMatchObject({ status: 400 });
      expect(deps.patternScan.scan).not.toHaveBeenCalled();
    });

    it('503s when the scan service is not wired', async () => {
      const { ctrl } = build({ patternScan: undefined });
      await expect(ctrl.triggerScan(SECRET, { targets: [TARGET] })).rejects.toMatchObject({
        status: 503,
      });
    });
  });
});
