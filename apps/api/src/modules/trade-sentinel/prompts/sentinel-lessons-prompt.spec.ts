import {
  LESSONS_MEMORY_LINE,
  sentinelCompositePromptVersion,
  sentinelPromptVersion,
  sentinelSystemPrompt,
  type SentinelPromptOptions,
} from './sentinel-system-prompt';
import {
  isOvernightPromptVersion,
  OVERNIGHT_LESSONS_LINE,
  overnightPromptFor,
  SENTINEL_OVERNIGHT_SCORECARD_SYSTEM_PROMPT,
  SENTINEL_OVERNIGHT_SYSTEM_PROMPT,
} from './sentinel-overnight-prompt';
import { SentinelAgentService } from '../services/sentinel-agent.service';

const COMBOS: SentinelPromptOptions[] = [];
for (const cues of [true, false]) for (const triggers of [true, false]) for (const discipline of [true, false]) for (const news of [true, false]) COMBOS.push({ cues, triggers, discipline, news });

describe('live prompt +l1 (SELF_REVIEW_LESSONS)', () => {
  it.each(COMBOS.map((o) => [JSON.stringify(o), o] as const))('%s: lessons off is untouched; on adds exactly the line and the suffix', (_n, o) => {
    const off = sentinelSystemPrompt(o);
    expect(sentinelSystemPrompt({ ...o, lessons: false })).toBe(off);
    const on = sentinelSystemPrompt({ ...o, lessons: true });
    expect(on.replace(LESSONS_MEMORY_LINE, '')).toBe(off);
    expect(on).toContain('never overrides the hard risk limits');
    expect(sentinelPromptVersion({ ...o, lessons: true })).toBe(`${sentinelPromptVersion(o)}+l1`);
  });

  it('the line follows the memory line', () => {
    const on = sentinelSystemPrompt({ cues: true, triggers: false, discipline: true, lessons: true });
    expect(on).toContain(`Stay consistent with them, or state explicitly what changed.\n${LESSONS_MEMORY_LINE}- The "trigger" block`);
  });

  it('every stamp stays distinct', () => {
    const stamps = COMBOS.flatMap((o) => [sentinelPromptVersion(o), sentinelPromptVersion({ ...o, lessons: true })]);
    expect(new Set(stamps).size).toBe(stamps.length);
  });

  it('the agent reads SELF_REVIEW_LESSONS: default on, off/observe off, no config off', () => {
    const agent = (env: Record<string, string> | null) =>
      new SentinelAgentService({} as never, env === null ? undefined : ({ get: (k: string) => env[k] } as never));
    expect(agent({}).promptVersion).toBe(sentinelCompositePromptVersion({ cues: false, triggers: false, discipline: true, lessons: true, delta: true, equity: true, squareOff: true, anchors: true }));
    // SENTINEL_PACKET_DELTA unset = on with a ConfigService: +d1 follows +l1 (judge gate).
    // SENTINEL_EQUITY_BLOCK / SENTINEL_SQUARE_OFF_LOOK / FLOOR_HARD_EXIT unset = on with a ConfigService: +e1+s1+a2 follow +d1.
    expect(agent({}).promptVersion).toMatch(/^v2\.4\+l1\+d1\+e1\+s1\+a2\//);
    expect(agent({ SELF_REVIEW_LESSONS: 'off' }).promptVersion).toMatch(/^v2\.4\+d1\+e1\+s1\+a2\//);
    expect(agent({ SELF_REVIEW_LESSONS: 'observe' }).promptVersion).toMatch(/^v2\.4\+d1\+e1\+s1\+a2\//);
    expect(agent(null).promptVersion).toMatch(/^v2\.4\//);
  });
});

describe('overnight prompt +l1 (packet-driven)', () => {
  const lessons = [{ key: 'k', text: 't', right: 2, wrong: 0 }];

  it('no lessons (absent or empty): o4 / o5 unchanged', () => {
    expect(overnightPromptFor({})).toEqual({ text: SENTINEL_OVERNIGHT_SYSTEM_PROMPT, version: 'o4/t1' });
    expect(overnightPromptFor({ memory: { lessons: [] } }).version).toBe('o4/t1');
    expect(overnightPromptFor({ overnight: { scorecard: {} } })).toEqual({ text: SENTINEL_OVERNIGHT_SCORECARD_SYSTEM_PROMPT, version: 'o5/t1' });
  });

  it('lessons in memory: the line after the memory line, and the suffix before the thesis part', () => {
    const o4 = overnightPromptFor({ memory: { lessons } });
    expect(o4.version).toBe('o4+l1/t1');
    expect(o4.text.replace(OVERNIGHT_LESSONS_LINE, '')).toBe(SENTINEL_OVERNIGHT_SYSTEM_PROMPT);
    expect(o4.text).toMatch(/- The "memory" block holds your own recent verdicts[^\n]*\n- memory\.lessons, when present/);
    const o5 = overnightPromptFor({ memory: { lessons }, overnight: { scorecard: {} } });
    expect(o5.version).toBe('o5+l1/t1');
    expect(o5.text.replace(OVERNIGHT_LESSONS_LINE, '')).toBe(SENTINEL_OVERNIGHT_SCORECARD_SYSTEM_PROMPT);
  });

  it('isOvernightPromptVersion accepts the suffixed stamps and still rejects live ones', () => {
    expect(isOvernightPromptVersion('o4+l1/t1')).toBe(true);
    expect(isOvernightPromptVersion('o5/t1')).toBe(true);
    expect(isOvernightPromptVersion('v9+l1/t1')).toBe(false);
  });
});
