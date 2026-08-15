import { replayVerdicts, replayVerdictsForUser, type ReplayRow } from './replay-verdicts';

const row = (id: string, verdict: string, promptVersion = 'v1/t1'): ReplayRow => ({
  id,
  symbol: 'INFY',
  verdict,
  // A distinct object per row, so "was the STORED packet replayed?" is decidable
  // by identity rather than by a structural match every packet would satisfy.
  packet: { position: { symbol: 'INFY' }, marker: id },
  promptVersion,
});

const agentThatSays = (...verdicts: string[]) => {
  const judge = jest.fn();
  for (const verdict of verdicts) judge.mockResolvedValueOnce({ verdict });
  return { judge, promptVersion: 'v2/t1' } as never;
};

describe('replayVerdicts', () => {
  it('counts a verdict that did not change as agreement', async () => {
    const report = await replayVerdicts([row('a', 'HOLD')], agentThatSays('HOLD'));

    expect(report.agreed).toBe(1);
    expect(report.changed).toBe(0);
    expect(report.failed).toBe(0);
    expect(report.diffs).toEqual([]);
  });

  it('records what changed, old and new, when a verdict flips', async () => {
    const report = await replayVerdicts([row('a', 'HOLD')], agentThatSays('EXIT_NOW'));

    expect(report.changed).toBe(1);
    expect(report.agreed).toBe(0);
    expect(report.diffs).toEqual([
      { id: 'a', symbol: 'INFY', was: 'HOLD', now: 'EXIT_NOW', storedPromptVersion: 'v1/t1' },
    ]);
  });

  it('replays the stored packet object itself, never a copy or a rebuild', async () => {
    const stored = row('a', 'HOLD');
    const agent = agentThatSays('HOLD');

    await replayVerdicts([stored], agent);

    // `toBe`, not `toEqual`: a rebuilt packet that happened to match structurally
    // would pass an equality check and defeat the whole point of the harness.
    expect((agent as unknown as { judge: jest.Mock }).judge.mock.calls[0][0]).toBe(stored.packet);
  });

  it('counts an agent rejection as a failure without aborting the run', async () => {
    const judge = jest
      .fn()
      .mockRejectedValueOnce(new Error('sentinel agent: verdict cites no evidence — rejected'))
      .mockResolvedValue({ verdict: 'HOLD' });
    const agent = { judge, promptVersion: 'v2/t1' } as never;

    const report = await replayVerdicts([row('a', 'HOLD'), row('b', 'HOLD')], agent);

    expect(report.total).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.agreed).toBe(1);
    // The rejection reason is the whole signal: a rise in rejections is how a
    // prompt regression shows up, and "1 failed" alone says nothing about why.
    expect(report.failures).toEqual([
      {
        id: 'a',
        symbol: 'INFY',
        was: 'HOLD',
        storedPromptVersion: 'v1/t1',
        error: 'sentinel agent: verdict cites no evidence — rejected',
      },
    ]);
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it('describes a non-Error rejection rather than recording "undefined"', async () => {
    const judge = jest.fn().mockRejectedValue('socket hang up');
    const report = await replayVerdicts([row('a', 'HOLD')], { judge, promptVersion: 'v2/t1' } as never);

    expect(report.failures[0].error).toBe('socket hang up');
  });

  it('names both the prompt version running now and every version that produced the corpus', async () => {
    const report = await replayVerdicts(
      [row('a', 'HOLD', 'v1/t1'), row('b', 'HOLD', 'v2/t1'), row('c', 'HOLD', 'v1/t1')],
      agentThatSays('HOLD', 'HOLD', 'HOLD'),
    );

    expect(report.promptVersion).toBe('v2/t1');
    // Deduplicated, and in first-seen order — a report read six months later has
    // to say what it was comparing against.
    expect(report.storedPromptVersions).toEqual(['v1/t1', 'v2/t1']);
  });

  it('reports an empty corpus as empty rather than failing', async () => {
    const agent = agentThatSays();
    const report = await replayVerdicts([], agent);

    expect(report).toEqual({
      total: 0,
      agreed: 0,
      changed: 0,
      failed: 0,
      promptVersion: 'v2/t1',
      storedPromptVersions: [],
      diffs: [],
      failures: [],
    });
    expect((agent as unknown as { judge: jest.Mock }).judge).not.toHaveBeenCalled();
  });
});

describe('replayVerdictsForUser', () => {
  it('reads the corpus for one user and writes nothing back', async () => {
    const stored = row('a', 'HOLD');
    const repo = { listForUser: jest.fn().mockResolvedValue([stored]), record: jest.fn() };

    const report = await replayVerdictsForUser(repo as never, agentThatSays('HOLD'), 'user-1', 50);

    expect(repo.listForUser).toHaveBeenCalledWith('user-1', 50);
    expect(report.agreed).toBe(1);
    // Replay is a measurement. A verdict written by a replay run would enter the
    // corpus as if the agent had seen a live position, and poison the next run.
    expect(repo.record).not.toHaveBeenCalled();
  });
});
