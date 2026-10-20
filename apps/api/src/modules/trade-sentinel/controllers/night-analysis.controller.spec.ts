import { NightAnalysisController, istAt } from './night-analysis.controller';

describe('NightAnalysisController.run (re-run last night with the current pipeline)', () => {
  const MON = new Date('2026-10-19T00:00:00Z');
  const mk = (dueDay: string) => {
    const scorecards = {
      run: jest.fn(async (_job: string, at: Date) =>
        at.toISOString().startsWith(dueDay) ? { ran: true, stored: 3 } : { ran: false, stored: 0, reason: 'not an NSE session window' },
      ),
    };
    const newsIdeas = { run: jest.fn(async () => ({ ran: true, candidates: 2, stored: 2 })) };
    const overnight = { runWindow: jest.fn(async () => ({ judged: 3 })) };
    const chains = { captureNow: jest.fn(async () => ({ ran: true, stored: 4 })) };
    const c = new NightAnalysisController(scorecards as never, newsIdeas as never, overnight as never, chains as never);
    return { c, scorecards, newsIdeas, overnight, chains };
  };

  it('walks back over the Dussehra holiday to Monday and runs scorecards, news, then the review', async () => {
    const t = mk('2026-10-19');
    const res = await t.c.run(new Date('2026-10-19T21:30:00Z')); // Tue 03:00 IST
    expect(res).toMatchObject({ started: true, session: '2026-10-19', chainCapture: { ran: true } });
    expect(t.chains.captureNow).toHaveBeenCalledTimes(1);
    expect(t.scorecards.run).toHaveBeenLastCalledWith('OVERNIGHT', istAt(MON, 15, 45));
    // newsIdeas fake always runs, so the re-run uses NOW (the eve of the next session) first
    expect(t.newsIdeas.run).toHaveBeenCalledWith('NIGHT', new Date('2026-10-19T21:30:00Z'));
    const call = t.overnight.runWindow.mock.calls[0] as unknown as [unknown, Date, { rerunTag: string }];
    expect(call[1]).toEqual(istAt(MON, 15, 48));
    expect(call[2].rerunTag).toMatch(/^rerun-\d{12}$/);
  });

  it('reports when no session is found and runs nothing else', async () => {
    const t = mk('1999-01-01');
    await expect(t.c.run(new Date('2026-10-19T21:30:00Z'))).resolves.toMatchObject({ started: false });
    expect(t.newsIdeas.run).not.toHaveBeenCalled();
    expect(t.overnight.runWindow).not.toHaveBeenCalled();
  });

  it('istAt gives 15:45 IST as 10:15 UTC', () => {
    expect(istAt(MON, 15, 45).toISOString()).toBe('2026-10-19T10:15:00.000Z');
  });
});
