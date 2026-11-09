import { createHash } from 'crypto';
import {
  SIGNAL_JUDGE_PROMPT_VERSION,
  SIGNAL_JUDGE_PROMPT_VERSION_TAKE,
  SIGNAL_JUDGE_SYSTEM,
  judgeTakeRule,
  signalJudgePromptVersion,
  signalJudgeSystem,
} from './judge';
import { parseJudgeDefault, parseSignalTraderConfig } from './signal-trader.config';

/** sha256 of the v5 system prompt as it was in prod before 2026-11-04 (SIGNAL_JUDGE_DEFAULT=skip must keep it). */
const V5_SHA256 = '1a6d854b686713389fa0dc7626e2baa78665f6cd17ab8ebd1ca44fb65942ce4c';
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('SIGNAL_JUDGE_DEFAULT prompt', () => {
  it('skip: byte-identical to the v6 prompt, version v6', () => {
    expect(sha(SIGNAL_JUDGE_SYSTEM)).toBe(V5_SHA256);
    expect(signalJudgeSystem('skip')).toBe(SIGNAL_JUDGE_SYSTEM);
    expect(signalJudgeSystem('skip', 80)).toBe(SIGNAL_JUDGE_SYSTEM);
    expect(signalJudgePromptVersion('skip')).toBe(SIGNAL_JUDGE_PROMPT_VERSION);
    expect(SIGNAL_JUDGE_PROMPT_VERSION).toBe('signal-judge-v6');
  });

  it('take: the default-take rule replaces the default-SKIP opening; everything else is kept', () => {
    const p = signalJudgeSystem('take');
    expect(signalJudgePromptVersion('take')).toBe(SIGNAL_JUDGE_PROMPT_VERSION_TAKE);
    expect(SIGNAL_JUDGE_PROMPT_VERSION_TAKE).toBe('signal-judge-v8-take');
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
    // v7 (2026-11-04 CRUDEOIL 8600 PE): a level the trend runs into is a break candidate, not a wall.
    expect(p).toMatch(/A nearby support or resistance is NOT concrete evidence when the trend already runs WITH the call/);
    expect(p).toMatch(/A level is a wall only when the trend is flat or against the call/);
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

describe('no risk-reward test at entry (owner 2026-11-09)', () => {
  it('the system prompt tells the judge the rupee stop handles the loss, and never to skip on risk or reward', () => {
    expect(SIGNAL_JUDGE_SYSTEM).toMatch(/no risk-reward test and no per-trade risk limit at entry/);
    expect(SIGNAL_JUDGE_SYSTEM).toMatch(/Never SKIP because plan\.riskRupees is above caps\.maxLossPerTrade/);
    expect(SIGNAL_JUDGE_SYSTEM).not.toMatch(/judge THAT stop on its noise distance/);
    expect(SIGNAL_JUDGE_SYSTEM).not.toMatch(/clearly pays for the/);
  });
  it('a stop inside noise is no longer concrete evidence against a call', () => {
    expect(judgeTakeRule(60)).not.toMatch(/stop inside ordinary noise/);
  });
});
