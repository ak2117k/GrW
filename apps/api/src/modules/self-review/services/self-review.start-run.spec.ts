import { BadRequestException } from '@nestjs/common';
import { SelfReviewService } from './self-review.service';

function make(rejection: string | null = null) {
  const runner = {
    isEnabled: () => true,
    isRunning: () => false,
    sessionRejection: jest.fn(() => rejection),
    run: jest.fn(async () => ({ started: true })),
  };
  return { runner, svc: new SelfReviewService({} as never, {} as never, runner as never) };
}

describe('SelfReviewService.startRun (POST /api/self-review/run)', () => {
  const NOW = new Date('2026-11-12T06:00:00Z');

  it('no session: the last closed session, as before', () => {
    const { svc, runner } = make();
    expect(svc.startRun(undefined, NOW)).toEqual({ started: true });
    expect(runner.run).toHaveBeenCalledWith(NOW, 'manual', {});
    expect(runner.sessionRejection).not.toHaveBeenCalled();
  });

  it('a session backfills that day (e.g. the MCX-only 2026-11-10)', () => {
    const { svc, runner } = make();
    expect(svc.startRun(' 2026-11-10 ', NOW)).toEqual({ started: true, session: '2026-11-10' });
    expect(runner.sessionRejection).toHaveBeenCalledWith('2026-11-10', NOW);
    expect(runner.run).toHaveBeenCalledWith(NOW, 'manual 2026-11-10', { session: '2026-11-10' });
  });

  it('a session that cannot be reviewed is a 400 and starts nothing', () => {
    const { svc, runner } = make('2026-11-08 not a trading day on NSE or MCX');
    expect(() => svc.startRun('2026-11-08', NOW)).toThrow(BadRequestException);
    expect(runner.run).not.toHaveBeenCalled();
  });
});
