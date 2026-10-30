import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { closeMinOf, replayEntry, stepTimes, type EntryFixtureV1 } from './replay-entry';

const ist = (d: Date) => new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(11, 16);

describe('entry replay', () => {
  it('steps on the cron cadence (:05/:20/:35/:50) inside 09:20–23:00 and before the close', () => {
    const nse = stepTimes({ date: '2026-10-30', optionExchange: 'NFO' }).map(ist);
    expect(nse[0]).toBe('09:20');
    expect(nse[nse.length - 1]).toBe('15:20');
    const mcx = stepTimes({ date: '2026-10-29', optionExchange: 'MCX' }).map(ist);
    expect(mcx[mcx.length - 1]).toBe('22:50');
    expect(closeMinOf('MCX', '2026-10-29')).toBe(23 * 60 + 30);
    expect(closeMinOf('MCX', '2026-11-03')).toBe(23 * 60 + 55);
  });

  // The real prod export is git-ignored (fixtures/*.real.json); replayed when present.
  const crude = join(__dirname, 'fixtures', 'crude-2026-10-29.real.json');
  (existsSync(crude) ? it : it.skip)('CRUDEOIL 2026-10-29 (prod export): the first ENTER is a PE and every step is explained', () => {
    const steps = replayEntry(JSON.parse(readFileSync(crude, 'utf8')) as EntryFixtureV1);
    const first = steps.find((s) => s.decision.action !== 'NO_TRADE');
    expect(first?.decision.action).toBe('ENTER_PE');
    expect(steps.filter((s) => s.wouldOpen)).toHaveLength(1);
    for (const s of steps) expect(s.decision.reasons).toHaveLength(3);
  });
});
