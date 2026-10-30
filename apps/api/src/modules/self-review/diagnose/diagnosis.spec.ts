import { Logger } from '@nestjs/common';
import {
  buildDiagnosisUserMessage,
  capMisses,
  DIAGNOSIS_MAX_TOKENS,
  DIAGNOSIS_SCHEMA,
  USER_MESSAGE_MAX_CHARS,
  validateDiagnosis,
} from './diagnosis-prompt';
import { DiagnosisService } from './diagnosis.service';
import { diagnosisForRun, type MissInput } from './types';
import type { LessonRecord } from '../lessons/types';

const miss = (refId: string, over: Partial<MissInput> = {}): MissInput => ({
  kind: 'OVERNIGHT_VERDICT', refId, symbol: 'NIFTY', predicted: 'HOLD_OVERNIGHT', actual: 'premium -32%', score: -1200, ...over,
});
const lesson = (key: string): LessonRecord => ({
  id: key, key, text: 'Exit on a gap.', scope: 'SENTINEL_OVERNIGHT', rightCount: 3, wrongCount: 0, status: 'ACTIVE',
  firstSeen: new Date(0), lastSeen: new Date(0), sourceRun: null, sessions: [],
});

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('validateDiagnosis', () => {
  const sent = ['r1', 'r2', 'r3'];
  const active = new Set(['old-key']);

  it('rejects a reply that is not {misses: [...]}', () => {
    expect(() => validateDiagnosis([], sent, active)).toThrow('not an object');
    expect(() => validateDiagnosis({ ideas: [] }, sent, active)).toThrow('no misses');
  });

  it('keeps a well-formed entry with every optional field', () => {
    const out = validateDiagnosis(
      { misses: [{ refIds: ['r1', 'r1', 'r2'], cause: ' gap down ', category: 'THESIS_WRONG', lessonKey: 'exit-on-gap', lessonText: 'Exit on a gap.', scope: 'SENTINEL_OVERNIGHT', contradicts: ['old-key'], proposalTarget: 'scorecard.factor.news.weight', proposedValue: 0.5 }] },
      sent,
      active,
    );
    expect(out).toEqual([
      { refIds: ['r1', 'r2'], cause: 'gap down', category: 'THESIS_WRONG', lessonKey: 'exit-on-gap', lessonText: 'Exit on a gap.', scope: 'SENTINEL_OVERNIGHT', contradicts: ['old-key'], proposalTarget: 'scorecard.factor.news.weight', proposedValue: 0.5 },
    ]);
  });

  it('drops entries with no known refId, no cause or an unknown category', () => {
    const out = validateDiagnosis(
      { misses: [
        { refIds: ['ghost'], cause: 'c', category: 'TIMING' },
        { refIds: ['r1'], cause: '', category: 'TIMING' },
        { refIds: ['r1'], cause: 'c', category: 'VIBES' },
        'nonsense',
        { refIds: ['r3'], cause: 'ok', category: 'TIMING' },
      ] },
      sent,
      active,
    );
    expect(out).toEqual([{ refIds: ['r3'], cause: 'ok', category: 'TIMING' }]);
  });

  it('drops a bad optional field alone', () => {
    const [d] = validateDiagnosis(
      { misses: [{ refIds: ['r1'], cause: 'c', category: 'TIMING', lessonKey: 'Bad Key!', lessonText: 'x', scope: 'MOON', contradicts: ['unknown-key'], proposalTarget: 'x; drop table', proposedValue: 1 }] },
      sent,
      active,
    );
    expect(d).toEqual({ refIds: ['r1'], cause: 'c', category: 'TIMING' });
  });

  it('a new key needs text; an active key may come without; NOISE never carries a lesson', () => {
    const out = validateDiagnosis(
      { misses: [
        { refIds: ['r1'], cause: 'c', category: 'TIMING', lessonKey: 'brand-new' },
        { refIds: ['r2'], cause: 'c', category: 'TIMING', lessonKey: 'old-key' },
        { refIds: ['r3'], cause: 'c', category: 'NOISE', lessonKey: 'noise-key', lessonText: 'T.' },
      ] },
      sent,
      active,
    );
    expect(out.map((d) => d.lessonKey)).toEqual([undefined, 'old-key', undefined]);
  });

  describe('grounding against the scorecard points', () => {
    // Real 2026-10-26 case: RELIANCE call AGAINST from expiry −2 / vix −1 / fii −1; no index-trend factor.
    const scored = new Map([['r1', { oi: 0, fii_dii: -1, vix: -1, expiry: -2, news: 0, indicators: -1, mood: 1 }]]);
    const entry = (over: Record<string, unknown>) => ({ misses: [{ refIds: ['r1'], cause: 'c', category: 'FACTOR_MISREAD', lessonKey: 'some-lesson', lessonText: 'T.', ...over }] });

    it('drops the lesson and proposal when the blamed factor was not scored (keeps the cause)', () => {
      const [d] = validateDiagnosis(entry({ blamedFactors: ['indexTrend'], proposalTarget: 'scorecard.factor.news.weight', proposedValue: 0.5 }), sent, active, scored);
      expect(d).toMatchObject({ refIds: ['r1'], cause: 'c', blamedFactors: ['indexTrend'] });
      expect(d.lessonKey).toBeUndefined();
      expect(d.proposalTarget).toBeUndefined();
      expect(d.dropped).toMatch(/lesson some-lesson \+ proposal scorecard\.factor\.news\.weight: blamed indexTrend not scored non-zero/);
    });

    it('drops it when no factor is named, or a blamed factor scored 0', () => {
      expect(validateDiagnosis(entry({}), sent, active, scored)[0].lessonKey).toBeUndefined();
      expect(validateDiagnosis(entry({ blamedFactors: ['expiry', 'news'] }), sent, active, scored)[0].dropped).toMatch(/blamed news not scored/);
    });

    it('keeps a lesson that blames factors with non-zero points; a weight proposal must be for one of them', () => {
      const [ok] = validateDiagnosis(entry({ blamedFactors: ['expiry', 'vix'], proposalTarget: 'scorecard.factor.vix.weight', proposedValue: 0.5 }), sent, active, scored);
      expect(ok).toMatchObject({ lessonKey: 'some-lesson', proposalTarget: 'scorecard.factor.vix.weight', blamedFactors: ['expiry', 'vix'] });
      expect(ok.dropped).toBeUndefined();
      const [bad] = validateDiagnosis(entry({ blamedFactors: ['expiry'], proposalTarget: 'scorecard.factor.vix.weight', proposedValue: 0.5 }), sent, active, scored);
      expect(bad.dropped).toMatch(/weight for vix, which is not a blamed factor/);
    });

    it('misses without factor points (verdicts, ideas) are not checked', () => {
      expect(validateDiagnosis(entry({ refIds: ['r2'] }), sent, active, scored)[0].lessonKey).toBe('some-lesson');
    });

    it('a proposal for a target off the allow-list is dropped, the lesson kept', () => {
      const [d] = validateDiagnosis({ misses: [{ refIds: ['r2'], cause: 'c', category: 'TIMING', lessonKey: 'k-two', lessonText: 'T.', proposalTarget: 'scorecard.factor.indexTrend.weight', proposedValue: 0.5 }] }, sent, active);
      expect(d).toMatchObject({ lessonKey: 'k-two', dropped: 'proposal scorecard.factor.indexTrend.weight: not a tunable' });
      expect(d.proposalTarget).toBeUndefined();
    });
  });

  it('clamps lesson text to 400 chars', () => {
    const [d] = validateDiagnosis({ misses: [{ refIds: ['r1'], cause: 'c', category: 'TIMING', lessonKey: 'long-one', lessonText: 'x '.repeat(400) }] }, sent, active);
    expect(d.lessonText!.length).toBeLessThanOrEqual(400);
  });
});

describe('capMisses / buildDiagnosisUserMessage', () => {
  it('keeps at most 15, the costliest first, in input order', () => {
    const misses = Array.from({ length: 20 }, (_, i) => miss(`r${i}`, { score: i }));
    const { sent, dropped } = capMisses(misses);
    expect(dropped).toBe(5);
    expect(sent.map((m) => m.refId)).toEqual(Array.from({ length: 15 }, (_, i) => `r${i + 5}`));
  });

  it('holds the message under the input cap by shrinking the excerpts', () => {
    const big = 'y'.repeat(50_000);
    const misses = Array.from({ length: 15 }, (_, i) => miss(`r${i}`, { inputs: { packet: big }, details: big }));
    const msg = buildDiagnosisUserMessage(misses, [lesson('old-key')]);
    expect(msg.length).toBeLessThanOrEqual(USER_MESSAGE_MAX_CHARS);
    const parsed = JSON.parse(msg);
    expect(parsed.misses).toHaveLength(15);
    expect(parsed.activeLessons).toEqual([{ key: 'old-key', text: 'Exit on a gap.', scope: 'SENTINEL_OVERNIGHT', right: 3, wrong: 0 }]);
  });
});

describe('DiagnosisService', () => {
  const reply = (text: string, stop: string | null = 'end_turn') => ({ content: [{ type: 'text', text }], stop_reason: stop });
  const make = (create: jest.Mock, env: Record<string, string> = {}, active: LessonRecord[] = [lesson('old-key')]) => {
    const lessons = { activeFor: jest.fn().mockResolvedValue(active) };
    const config = { get: (k: string) => env[k] };
    return { svc: new DiagnosisService({ messages: { create } }, lessons as never, config as never), lessons };
  };

  it('one call on the overnight routing, strict JSON → OK', async () => {
    const create = jest.fn().mockResolvedValue(reply('```json\n{"misses":[{"refIds":["r1"],"cause":"gap","category":"THESIS_WRONG","lessonKey":"old-key"}]}\n```'));
    const { svc } = make(create, { SENTINEL_MODEL_TRIGGERED: 'claude-x', SENTINEL_EFFORT_TRIGGERED: 'medium' });
    const res = await svc.diagnose('run1', [miss('r1'), miss('r2')]);
    expect(res).toMatchObject({ status: 'OK', sent: 2, dropped: 0, model: 'claude-x', promptVersion: 'd4' });
    expect(res.misses).toEqual([{ refIds: ['r1'], cause: 'gap', category: 'THESIS_WRONG', lessonKey: 'old-key' }]);
    expect(create).toHaveBeenCalledTimes(1);
    const req = create.mock.calls[0][0];
    expect(req).toMatchObject({ model: 'claude-x', max_tokens: DIAGNOSIS_MAX_TOKENS, output_config: { effort: 'medium', format: { type: 'json_schema', schema: DIAGNOSIS_SCHEMA } } });
    expect(JSON.parse(req.messages[0].content).misses.map((m: MissInput) => m.refId)).toEqual(['r1', 'r2']);
    expect(diagnosisForRun(res)).toEqual({ misses: res.misses, promptVersion: 'd4', model: 'claude-x' });
  });

  it('checks the reply against the scorecard points it was sent', async () => {
    const create = jest.fn().mockResolvedValue(reply('{"misses":[{"refIds":["s1"],"cause":"tape","category":"FACTOR_MISREAD","lessonKey":"tape-veto","lessonText":"T.","blamedFactors":["indexTrend"]}]}'));
    const res = await make(create).svc.diagnose('r', [miss('s1', { kind: 'SCORECARD_TOTAL', details: { factors: { expiry: -2, vix: -1 } } })]);
    expect(res.misses[0].lessonKey).toBeUndefined();
    expect(res.misses[0].dropped).toMatch(/blamed indexTrend/);
  });

  it('defaults to the compiled sentinel tier', async () => {
    const create = jest.fn().mockResolvedValue(reply('{"misses":[]}'));
    await make(create).svc.diagnose('r', [miss('r1')]);
    expect(create.mock.calls[0][0]).toMatchObject({ model: 'claude-opus-5', output_config: { effort: 'high' } });
  });

  it('no misses → SKIPPED without a call', async () => {
    const create = jest.fn();
    const res = await make(create).svc.diagnose('r', []);
    expect(res.status).toBe('SKIPPED');
    expect(create).not.toHaveBeenCalled();
    expect(diagnosisForRun(res)).toBeNull();
  });

  it.each<[string, jest.Mock]>([
    ['transport throws', jest.fn().mockRejectedValue(new Error('cli session expired'))],
    ['max_tokens', jest.fn().mockResolvedValue(reply('{"misses":[', 'max_tokens'))],
    ['refusal', jest.fn().mockResolvedValue(reply('', 'refusal'))],
    ['not JSON', jest.fn().mockResolvedValue(reply('I think the trade was fine.'))],
    ['wrong envelope', jest.fn().mockResolvedValue(reply('{"ideas":[]}'))],
  ])('fails soft: %s', async (_n, create) => {
    const res = await make(create).svc.diagnose('r', [miss('r1')]);
    expect(res.status).toBe('FAILED');
    expect(res.misses).toEqual([]);
    expect(res.reason).toBeTruthy();
    expect(diagnosisForRun(res)).toBeNull();
  });

  it('the signal paper splits go in (even with no misses) and the assessment comes back; the prompt asks for "insufficient sample"', async () => {
    const signalPaper = { rolling20: { byOi: { AGAINST: { n: 4, closed: 4, wins: 1, losses: 3, winRate: 0.25, gross: -2100 } } }, sessionTrades: [{ symbol: 'CRUDEOIL17NOV265400CE', oi: 'AGAINST', oiWhy: 'AGAINST (chain …)' }] };
    const create = jest.fn().mockResolvedValue(reply('{"misses":[],"signalPaperAssessment":"  AGAINST 1W/3L −₹2,100 vs AGREES 2W/0L; insufficient sample.  "}'));
    const res = await make(create).svc.diagnose('r', [], { signalPaper });
    expect(create).toHaveBeenCalledTimes(1);
    const req = create.mock.calls[0][0];
    expect(JSON.parse(req.messages[0].content).signalPaper).toEqual(signalPaper);
    expect(req.system[0].text).toMatch(/AGAINST trades underperformed the AGREES/);
    expect(req.system[0].text).toMatch(/fewer than 10 closed trades .* "insufficient sample"/);
    expect(res).toMatchObject({ status: 'OK', misses: [], signalPaperAssessment: 'AGAINST 1W/3L −₹2,100 vs AGREES 2W/0L; insufficient sample.' });
    expect(diagnosisForRun(res)?.signalPaperAssessment).toBe(res.signalPaperAssessment);
    // Without signalPaper, an assessment in the reply is ignored and the message carries no signalPaper.
    const c2 = jest.fn().mockResolvedValue(reply('{"misses":[],"signalPaperAssessment":"x"}'));
    const r2 = await make(c2).svc.diagnose('r', [miss('r1')]);
    expect(r2.signalPaperAssessment).toBeUndefined();
    expect(JSON.parse(c2.mock.calls[0][0].messages[0].content).signalPaper).toBeUndefined();
  });

  it('the exit noise reads go in (even with no misses) and their assessment comes back; under 10 scored reads the prompt asks for "insufficient sample"', async () => {
    const noiseReads = { rolling20: { reads: 3, scored: 2, noiseRight: '1/2', realRight: '0/0' }, sessionReads: [{ symbol: 'SENSEX26N0574500CE', verdict: 'NOISE', score: 'RIGHT' }] };
    const create = jest.fn().mockResolvedValue(reply('{"misses":[],"exitNoiseAssessment":"  NOISE right 1/2, REAL 0/0; insufficient sample.  "}'));
    const res = await make(create).svc.diagnose('r', [], { noiseReads });
    expect(create).toHaveBeenCalledTimes(1);
    const req = create.mock.calls[0][0];
    expect(JSON.parse(req.messages[0].content).noiseReads).toEqual(noiseReads);
    expect(req.system[0].text).toMatch(/fewer than 10 scored reads of a verdict, say "insufficient sample"/);
    expect(req.system[0].text).toMatch(/never a lesson or a proposal\. Leave exitNoiseAssessment out/);
    expect(res).toMatchObject({ status: 'OK', misses: [], exitNoiseAssessment: 'NOISE right 1/2, REAL 0/0; insufficient sample.' });
    expect(res.signalPaperAssessment).toBeUndefined();
    expect(diagnosisForRun(res)?.exitNoiseAssessment).toBe(res.exitNoiseAssessment);
    // Without noiseReads, an assessment in the reply is ignored.
    const c2 = jest.fn().mockResolvedValue(reply('{"misses":[],"exitNoiseAssessment":"x"}'));
    const r2 = await make(c2).svc.diagnose('r', [miss('r1')]);
    expect(r2.exitNoiseAssessment).toBeUndefined();
    expect(JSON.parse(c2.mock.calls[0][0].messages[0].content).noiseReads).toBeUndefined();
  });

  it('diagnoses without lessons when they cannot be read', async () => {
    const create = jest.fn().mockResolvedValue(reply('{"misses":[]}'));
    const { svc, lessons } = make(create);
    lessons.activeFor.mockRejectedValue(new Error('db'));
    expect((await svc.diagnose('r', [miss('r1')])).status).toBe('OK');
    expect(JSON.parse(create.mock.calls[0][0].messages[0].content).activeLessons).toEqual([]);
  });
});
