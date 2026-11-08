import { makeSentinelClock } from '../../trade-sentinel/overnight/overnight-calendar';
import { SELF_REVIEW_CRON } from '../services/self-review.cron';
import { AUTO_APPLY_CRON, AutoApplyCron } from './auto-apply.cron';

function make() {
  const svc = { isEnabled: () => true, run: jest.fn(async () => ({ applied: [], rolledBack: [], blocked: [] })) };
  return { svc, cron: new AutoApplyCron(svc as never, makeSentinelClock()) };
}

describe('AutoApplyCron', () => {
  it('runs at 01:15 IST Tue-Sat, after the 00:30 self-review and its 30-minute lease', () => {
    expect(SELF_REVIEW_CRON).toBe('0 30 0 * * 2-6');
    expect(AUTO_APPLY_CRON).toBe('0 15 1 * * 2-6');
  });

  it('01:15 Saturday acts for Friday; 01:15 Sunday does nothing', async () => {
    const sat = make();
    const now = new Date('2026-11-06T19:45:00Z'); // Sat 7 Nov 01:15 IST
    await sat.cron.fire(now);
    expect(sat.svc.run).toHaveBeenCalledWith(now);
    const sun = make();
    await sun.cron.fire(new Date('2026-11-07T19:45:00Z')); // Sun 8 Nov 01:15 IST
    expect(sun.svc.run).not.toHaveBeenCalled();
  });
});
