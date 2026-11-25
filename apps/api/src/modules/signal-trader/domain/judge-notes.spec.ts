import {
  SIGNAL_JUDGE_PROMPT_VERSION_NOTES,
  SIGNAL_JUDGE_PROMPT_VERSION_TAKE_NOTES,
  SIGNAL_JUDGE_SYSTEM,
  signalJudgePromptVersion,
  signalJudgeSystem,
} from './judge';

describe('verifiedNotes judge prompt (MESSAGE_READER=on)', () => {
  it('prompt version is signal-judge-v9-take only when notes are on', () => {
    expect(signalJudgePromptVersion('take', true)).toBe('signal-judge-v9-take');
    expect(signalJudgePromptVersion('skip', true)).toBe('signal-judge-v7');
    expect(SIGNAL_JUDGE_PROMPT_VERSION_TAKE_NOTES).toBe('signal-judge-v9-take');
    expect(SIGNAL_JUDGE_PROMPT_VERSION_NOTES).toBe('signal-judge-v7');
    expect(signalJudgePromptVersion('take', false)).toBe('signal-judge-v8-take');
    expect(signalJudgePromptVersion('skip', false)).toBe('signal-judge-v6');
    expect(signalJudgePromptVersion('take')).toBe('signal-judge-v8-take');
  });

  it('verifiedNotes prompt line only when notes are on; the off prompts are unchanged', () => {
    expect(signalJudgeSystem('skip', 60, false)).toBe(SIGNAL_JUDGE_SYSTEM);
    expect(signalJudgeSystem('take', 60, false)).toBe(signalJudgeSystem('take', 60));
    for (const mode of ['skip', 'take'] as const) {
      const off = signalJudgeSystem(mode, 60);
      const on = signalJudgeSystem(mode, 60, true);
      expect(off).not.toMatch(/verifiedNotes/);
      expect(on).toMatch(/channelViews\.verifiedNotes = channel claims checked against our data at post time/);
      expect(on).toMatch(/never a trigger to take or skip on their own/);
      expect(on).toMatch(/weighted by the verdict — never a trigger/);
      // Final review #3: the notes carry no channel accuracy (night scores are not consumed yet), so the rule cites none.
      expect(on).not.toMatch(/information accuracy/);
      expect(on).toMatch(/a CONTRADICTED note counts against the channel's claim, not for the opposite trade/);
      // The line sits right after the channelViews line; nothing else changes.
      expect(on.replace(/ channelViews\.verifiedNotes = [^]*?not for the opposite trade\./, '')).toBe(off);
    }
  });
});
