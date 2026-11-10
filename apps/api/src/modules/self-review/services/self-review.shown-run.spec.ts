import { shownRun } from './self-review.service';

const run = (id: string, diagnosis: unknown) => ({ id, diagnosis });

describe('shownRun: the run the self-review page shows', () => {
  it('the 02:30 missed-moves run has no diagnosis: show the 00:30 run of the same night (prod 2026-11-10: the page was empty)', () => {
    const late = run('0230', null);
    expect(shownRun(late, [late, run('0030', { misses: [1] })]).id).toBe('0030');
  });
  it('a diagnosed latest run is shown as it is', () => {
    const late = run('0230', { misses: [] });
    expect(shownRun(late, [late, run('0030', { misses: [1] })]).id).toBe('0230');
  });
  it('no diagnosed run that night: the latest', () => {
    const late = run('0230', null);
    expect(shownRun(late, [late, run('0030', null)]).id).toBe('0230');
  });
});
