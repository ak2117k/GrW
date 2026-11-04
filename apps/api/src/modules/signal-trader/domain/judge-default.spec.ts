import { createHash } from 'crypto';
import {
  SIGNAL_JUDGE_PROMPT_VERSION,
  SIGNAL_JUDGE_PROMPT_VERSION_TAKE,
  SIGNAL_JUDGE_SYSTEM,
  signalJudgePromptVersion,
  signalJudgeSystem,
} from './judge';
import { parseJudgeDefault, parseSignalTraderConfig } from './signal-trader.config';

/** sha256 of the v5 system prompt as it was in prod before 2026-11-04 (SIGNAL_JUDGE_DEFAULT=skip must keep it). */
const V5_SHA256 = '56c1084f13aebd3af03073292a10f28080781a29d6f99de8a14385171b753ca3';
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('SIGNAL_JUDGE_DEFAULT prompt', () => {
  it('skip: byte-identical to the v5 prompt, version v5', () => {
    expect(sha(SIGNAL_JUDGE_SYSTEM)).toBe(V5_SHA256);
    expect(signalJudgeSystem('skip')).toBe(SIGNAL_JUDGE_SYSTEM);
    expect(signalJudgeSystem('skip', 80)).toBe(SIGNAL_JUDGE_SYSTEM);
    expect(signalJudgePromptVersion('skip')).toBe(SIGNAL_JUDGE_PROMPT_VERSION);
    expect(SIGNAL_JUDGE_PROMPT_VERSION).toBe('signal-judge-v5');
  });

  it('take: the default-take rule replaces the default-SKIP opening; everything else is kept', () => {
    const p = signalJudgeSystem('take');
    expect(signalJudgePromptVersion('take')).toBe(SIGNAL_JUDGE_PROMPT_VERSION_TAKE);
    expect(SIGNAL_JUDGE_PROMPT_VERSION_TAKE).toBe('signal-judge-v6-take');
    expect(p).not.toMatch(/your default is SKIP/);
    expect(p).toMatch(/Your default is TAKE: take the channel's call unless there is CONCRETE EVIDENCE AGAINST it/);
    expect(p).toMatch(/price is already past T1/);
    expect(p).toMatch(/stop is already broken/);
    expect(p).toMatch(/outside the tolerance band/);
    expect(p).toMatch(/expiry-day or illiquid/);
    expect(p).toMatch(/hard risk/);
    expect(p).toMatch(/mixed or neutral news are NEVER by themselves a\s+reason to SKIP/);
    expect(p).toMatch(/events\.status "absent" means we could not read the calendar — NOT that there is no event/);
    expect(p).toMatch(/on such a day missing data counts for nothing/);
    expect(p).toMatch(/confidence 65 or more; code SKIPs a TAKE below 60\./);
    // The v5 rules all survive.
    for (const rule of [/never guess "inside noise": market\.noise/, /intrinsic value is from the SPOT .* NEVER the future/, /sampleSufficient is false/, /Reply with ONLY a JSON object/]) expect(p).toMatch(rule);
    expect(p.startsWith('You are the entry judge for trade signals copied from Telegram tip channels into a real Indian F&O / equity account. Your default is TAKE')).toBe(true);
  });

  it('take: the confidence line follows SIGNAL_JUDGE_MIN_CONFIDENCE', () => {
    expect(signalJudgeSystem('take', 70)).toMatch(/confidence 75 or more; code SKIPs a TAKE below 70\./);
  });
});

describe('parseJudgeDefault', () => {
  it('unset → take; take|skip as given; a typo → skip (reported)', () => {
    expect(parseSignalTraderConfig({}).judgeDefault).toBe('take');
    expect(parseSignalTraderConfig({ SIGNAL_JUDGE_DEFAULT: 'SKIP' }).judgeDefault).toBe('skip');
    expect(parseSignalTraderConfig({ SIGNAL_JUDGE_DEFAULT: ' take ' }).judgeDefault).toBe('take');
    const problems: string[] = [];
    expect(parseJudgeDefault('tkae', problems)).toBe('skip');
    expect(problems).toEqual([expect.stringMatching(/SIGNAL_JUDGE_DEFAULT=tkae is not take\|skip — using skip/)]);
  });
});
