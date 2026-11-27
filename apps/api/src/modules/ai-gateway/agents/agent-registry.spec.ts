import {
  AGENT_GROUPS,
  AGENT_PORT,
  agentUrl,
  agentsOn,
  DEFAULT_PROFILE,
  isTradingJob,
  loadAgentRegistry,
  parseAgentRegistry,
  SENTINEL_GATED_JOBS,
  sentinelJudgeConcurrency,
  TRADING_JOBS,
} from './agent-registry';

const FILE = {
  _note: 'comment',
  'sentinel.judge': { agent: 'trading', concurrency: 6, timeoutMs: 300000, model: null, effort: null, maxTokens: null },
  'signal.vision': { agent: 'reading', concurrency: 2, timeoutMs: 240000, model: null, effort: null, maxTokens: null },
  'backtest.*': { agent: 'background', concurrency: 2, timeoutMs: 200000, model: null, effort: null, maxTokens: null },
  'backtest.spec': { agent: 'background', concurrency: 1, timeoutMs: 100000, model: 'claude-opus-5', effort: 'high', maxTokens: 8000 },
};

describe('agent registry', () => {
  it('parses profiles; _ keys are comments', () => {
    const r = parseAgentRegistry(FILE, {});
    expect(r.profile('sentinel.judge')).toEqual(FILE['sentinel.judge']);
    expect(r.profile('signal.vision').agent).toBe('reading');
    expect(r.jobsOf('trading')).toEqual(['sentinel.judge']);
    expect(r.jobsOf('background')).toEqual(['backtest.*', 'backtest.spec']);
  });

  it('prefix keys match by prefix; an exact key wins', () => {
    const r = parseAgentRegistry(FILE, {});
    expect(r.profile('backtest.summary').timeoutMs).toBe(200000);
    expect(r.profile('backtest.spec')).toEqual(FILE['backtest.spec']);
  });

  it('unknown job -> background default profile, warned once', () => {
    const warn = jest.fn();
    const r = parseAgentRegistry(FILE, {}, warn);
    expect(r.profile('portfolio.review')).toEqual(DEFAULT_PROFILE);
    r.profile('portfolio.review');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('env AGENT_<JOB>_<FIELD> beats the file, including for unknown jobs', () => {
    const r = parseAgentRegistry(
      FILE,
      {
        AGENT_SENTINEL_JUDGE_CONCURRENCY: '8',
        AGENT_SENTINEL_JUDGE_MODEL: 'claude-sonnet-5',
        AGENT_SENTINEL_JUDGE_EFFORT: 'medium',
        AGENT_SENTINEL_JUDGE_MAX_TOKENS: '12000',
        AGENT_SENTINEL_JUDGE_TIMEOUT_MS: '90000',
        AGENT_SIGNAL_VISION_AGENT: 'in-process',
        AGENT_BACKTEST_SPEC_MODEL: 'null',
        AGENT_SELF_REVIEW_DIAGNOSE_AGENT: 'reading',
      },
      () => undefined,
    );
    expect(r.profile('sentinel.judge')).toEqual({
      agent: 'trading',
      concurrency: 8,
      timeoutMs: 90000,
      model: 'claude-sonnet-5',
      effort: 'medium',
      maxTokens: 12000,
    });
    expect(r.profile('signal.vision').agent).toBe('in-process');
    expect(r.jobsOf('reading')).toEqual([]);
    expect(r.profile('backtest.spec').model).toBeNull();
    expect(r.profile('self-review.diagnose').agent).toBe('reading');
  });

  it('a malformed value throws (file or env)', () => {
    expect(() => parseAgentRegistry({ x: { agent: 'nope' } }, {})).toThrow(/agent must be/);
    expect(() => parseAgentRegistry({ x: { concurrency: 0 } }, {})).toThrow(/positive integer/);
    expect(() => parseAgentRegistry({ x: { maxTokens: 20000 } }, {})).toThrow(/<= 16000/);
    expect(() => parseAgentRegistry({ x: { effort: 'max' } }, {})).toThrow(/low\|medium\|high/);
    expect(() => parseAgentRegistry([], {})).toThrow(/JSON object/);
    const r = parseAgentRegistry(FILE, { AGENT_SENTINEL_JUDGE_CONCURRENCY: 'lots' });
    expect(() => r.profile('sentinel.judge')).toThrow(/positive integer/);
  });

  it('the shipped config/ai-agents.json matches design 4.2 / 4.4', () => {
    const r = loadAgentRegistry({});
    // desk.confirm (trade agent exit authority): the supreme confirm, its own 30 s semaphore beside desk.manager.
    expect(r.jobsOf('trading').sort()).toEqual(['desk.confirm', 'desk.manager', 'entry.judge', 'sentinel.judge', 'sentinel.thesis', 'signal.judge']);
    expect(r.profile('desk.confirm')).toMatchObject({ agent: 'trading', concurrency: 2, timeoutMs: 30_000 });
    expect(r.jobsOf('reading').sort()).toEqual(['news.impact', 'news.sentiment', 'setup.build', 'signal.image-setup', 'signal.info', 'signal.parse', 'signal.read', 'signal.vision']);
    expect(r.jobsOf('background').sort()).toEqual([
      'assist.advisor',
      'assist.news',
      'backtest.*',
      'news.brief',
      'news.ideas',
      'self-review.diagnose',
      'sentinel.overnight',
      'strategy.review',
      'strategy.suggest',
    ]);
    expect(r.profile('sentinel.judge').concurrency).toBe(6);
    expect(r.profile('signal.judge').concurrency).toBe(3);
    expect(r.profile('entry.judge').concurrency).toBe(3);
    expect(r.profile('sentinel.thesis').concurrency).toBe(3);
    // News AI (2026-11-23): news.sentiment reads every article (3 at once), news.brief is one Opus call at a time.
    expect(r.profile('news.sentiment').concurrency).toBe(3);
    expect(r.profile('news.brief').concurrency).toBe(1);
    // Message reader (2026-11-25): every Telegram post is read, 8 at once, 60 s bound.
    expect(r.profile('signal.read')).toMatchObject({ agent: 'reading', concurrency: 8, timeoutMs: 60000 });
    // Desk manager (2026-11-26): one Opus call per run, 1 at once, 120 s bound, on the trading agent.
    expect(r.profile('desk.manager')).toMatchObject({ agent: 'trading', concurrency: 1, timeoutMs: 120000 });
    expect(TRADING_JOBS).toContain('desk.manager');
    // AI setups (2026-11-25): one Opus call per verified claim, 2 at once, 120 s bound.
    expect(r.profile('setup.build')).toMatchObject({ agent: 'reading', concurrency: 2, timeoutMs: 120000 });
    const ownProfile = ['news.sentiment', 'news.brief', 'signal.read'];
    for (const job of [...r.jobsOf('reading'), ...r.jobsOf('background')].filter((j) => !ownProfile.includes(j))) expect(r.profile(job).concurrency).toBe(2);
    for (const g of AGENT_GROUPS) {
      for (const job of r.jobsOf(g)) {
        const p = r.profile(job);
        expect([p.model, p.effort, p.maxTokens]).toEqual([null, null, null]);
      }
    }
  });

  it('agentsOn truth table: AI_AGENTS=on AND SENTINEL_JUDGE=vertex', () => {
    expect(agentsOn({})).toBe(false);
    expect(agentsOn({ AI_AGENTS: 'on' })).toBe(false);
    expect(agentsOn({ AI_AGENTS: 'on', SENTINEL_JUDGE: 'cli' })).toBe(false);
    expect(agentsOn({ AI_AGENTS: 'on', SENTINEL_JUDGE: 'api' })).toBe(false);
    expect(agentsOn({ AI_AGENTS: 'off', SENTINEL_JUDGE: 'vertex' })).toBe(false);
    expect(agentsOn({ AI_AGENTS: 'true', SENTINEL_JUDGE: 'vertex' })).toBe(false);
    expect(agentsOn({ SENTINEL_JUDGE: 'vertex' })).toBe(false);
    expect(agentsOn({ AI_AGENTS: 'on', SENTINEL_JUDGE: 'vertex' })).toBe(true);
    expect(agentsOn({ AI_AGENTS: ' ON ', SENTINEL_JUDGE: 'Vertex' })).toBe(true);
  });

  it('agentUrl: env override (trailing / dropped) else the compose service name', () => {
    expect(AGENT_PORT).toBe(5300);
    expect(agentUrl('trading', {})).toBe('http://grw-agents-trading:5300');
    expect(agentUrl('reading', { AGENT_URL_READING: 'http://127.0.0.1:9999/' })).toBe('http://127.0.0.1:9999');
  });

  it('sentinelJudgeConcurrency: 2 when off/cli, registry value when on', () => {
    expect(sentinelJudgeConcurrency({})).toBe(2);
    expect(sentinelJudgeConcurrency({ AI_AGENTS: 'on', SENTINEL_JUDGE: 'cli' })).toBe(2);
    expect(sentinelJudgeConcurrency({ AI_AGENTS: 'on', SENTINEL_JUDGE: 'vertex' })).toBe(6);
    expect(
      sentinelJudgeConcurrency({ AI_AGENTS: 'on', SENTINEL_JUDGE: 'vertex', AGENT_SENTINEL_JUDGE_CONCURRENCY: '4' }),
    ).toBe(4);
  });

  it('sentinelJudgeConcurrency stays 2 while sentinel.judge is routed in-process (rollout steps 4-5)', () => {
    expect(
      sentinelJudgeConcurrency({ AI_AGENTS: 'on', SENTINEL_JUDGE: 'vertex', AGENT_SENTINEL_JUDGE_AGENT: 'in-process' }),
    ).toBe(2);
  });

  it('keyOf: own key / own env override = the job; otherwise the matching .* entry; unknown = the job', () => {
    const r = parseAgentRegistry(FILE, { AGENT_BACKTEST_NARRATE_CONCURRENCY: '3' }, () => undefined);
    expect(r.keyOf('sentinel.judge')).toBe('sentinel.judge');
    expect(r.keyOf('backtest.spec')).toBe('backtest.spec');
    expect(r.keyOf('backtest.summary')).toBe('backtest.*');
    expect(r.keyOf('backtest.narrate')).toBe('backtest.narrate');
    expect(r.keyOf('mystery.job')).toBe('mystery.job');
  });

  it('sentinelJudgeConcurrency keeps 2 when the registry is unusable', () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(
      sentinelJudgeConcurrency({ AI_AGENTS: 'on', SENTINEL_JUDGE: 'vertex', AGENT_SENTINEL_JUDGE_CONCURRENCY: 'x' }),
    ).toBe(2);
  });

  it('sentinel-gated jobs and trading class', () => {
    expect(SENTINEL_GATED_JOBS).toEqual(['sentinel.judge', 'sentinel.thesis', 'sentinel.overnight']);
    expect(isTradingJob('signal.judge', { ...DEFAULT_PROFILE, agent: 'in-process' })).toBe(true);
    expect(isTradingJob('news.ideas', DEFAULT_PROFILE)).toBe(false);
    expect(isTradingJob('news.ideas', { ...DEFAULT_PROFILE, agent: 'trading' })).toBe(true);
  });
});
