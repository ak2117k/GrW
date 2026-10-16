import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AI_JOBS, priorityOf } from '../ai-job';
import { loadRoutes, resolveAiConfig } from './route-config';

const json = () => ({
  'decision.judge': { provider: 'claude-cli', model: 'claude-sonnet-5', fallback: ['anthropic-api'], maxWaitMs: 20000 },
  'review.overnight': { provider: 'claude-cli', model: 'claude-sonnet-5', fallback: ['anthropic-api'], maxWaitMs: 120000 },
  'review.holdings': { provider: 'claude-cli', model: 'claude-sonnet-5', fallback: ['anthropic-api'], maxWaitMs: 120000 },
  'news.impact': { provider: 'claude-cli', model: 'claude-haiku-4-5', fallback: [], maxWaitMs: 60000 },
  'picks.next-day': { provider: 'claude-cli', model: 'claude-opus-5', fallback: [], maxWaitMs: 600000 },
  'picks.pre-market': { provider: 'claude-cli', model: 'claude-sonnet-5', fallback: [], maxWaitMs: 300000 },
  'learning.nightly': { provider: 'claude-cli', model: 'claude-opus-5', fallback: [], maxWaitMs: 1800000 },
  'strategy.draft': { provider: 'claude-cli', model: 'claude-opus-5', fallback: [], maxWaitMs: 600000 },
  'news.profile': { provider: 'claude-cli', model: 'claude-sonnet-5', fallback: [], maxWaitMs: 300000 },
  'news.audit': { provider: 'claude-cli', model: 'claude-sonnet-5', fallback: [], maxWaitMs: 600000 },
  'news.curate': { provider: 'claude-cli', model: 'claude-sonnet-5', fallback: [], maxWaitMs: 600000 },
  'news.label': { provider: 'claude-cli', model: 'claude-sonnet-5', fallback: [], maxWaitMs: 600000 },
});

const SENTINEL_JOBS = ['sentinel.judge', 'sentinel.overnight', 'sentinel.thesis', 'sentinel.unknown'] as const;

describe('loadRoutes', () => {
  it('derives every sentinel route from SENTINEL_JUDGE=cli, ignoring json and AI_ROUTE_* overrides', () => {
    const cfg = {
      ...json(),
      'sentinel.judge': { provider: 'anthropic-api', model: 'x', fallback: ['anthropic-api'], maxWaitMs: 1 },
    };
    const routes = loadRoutes(cfg, {
      SENTINEL_JUDGE: 'cli',
      AI_ROUTE_SENTINEL_JUDGE_PROVIDER: 'anthropic-api',
      AI_ROUTE_SENTINEL_JUDGE_MODEL: 'y',
    });
    for (const job of SENTINEL_JOBS) {
      expect(routes[job].provider).toBe('claude-cli');
      expect(routes[job].model).toBeNull();
      expect(routes[job].fallback).toEqual([]);
    }
  });

  it.each([undefined, '', 'garbage', 'api', 'bedrock'])(
    'SENTINEL_JUDGE=%p routes sentinel jobs to anthropic-api',
    (judge) => {
      const routes = loadRoutes(json(), judge === undefined ? {} : { SENTINEL_JUDGE: judge });
      for (const job of SENTINEL_JOBS) {
        expect(routes[job]).toEqual(
          expect.objectContaining({ provider: 'anthropic-api', model: null, fallback: [] }),
        );
      }
    },
  );

  it('covers every job', () => {
    const routes = loadRoutes(json(), {});
    expect(Object.keys(routes).sort()).toEqual([...AI_JOBS].sort());
  });

  it('takes non-sentinel routes from json', () => {
    const routes = loadRoutes(json(), {});
    expect(routes['decision.judge']).toEqual({
      provider: 'claude-cli',
      model: 'claude-sonnet-5',
      fallback: ['anthropic-api'],
      maxWaitMs: 20000,
    });
  });

  it('applies AI_ROUTE_<JOB>_MODEL and _PROVIDER overrides', () => {
    const routes = loadRoutes(json(), {
      AI_ROUTE_DECISION_JUDGE_MODEL: 'x',
      AI_ROUTE_PICKS_NEXT_DAY_PROVIDER: 'anthropic-api',
    });
    expect(routes['decision.judge'].model).toBe('x');
    expect(routes['picks.next-day'].provider).toBe('anthropic-api');
    expect(routes['news.impact'].model).toBe('claude-haiku-4-5');
  });

  it('throws on an unknown provider (json or env)', () => {
    const bad = { ...json(), 'news.impact': { provider: 'gpt', model: 'm', fallback: [], maxWaitMs: 1 } };
    expect(() => loadRoutes(bad, {})).toThrow(/^ai-routes: /);
    expect(() => loadRoutes(json(), { AI_ROUTE_NEWS_IMPACT_PROVIDER: 'gpt' })).toThrow(/^ai-routes: /);
    const badFallback = { ...json(), 'news.impact': { provider: 'claude-cli', model: 'm', fallback: ['gpt'], maxWaitMs: 1 } };
    expect(() => loadRoutes(badFallback, {})).toThrow(/^ai-routes: /);
  });

  it('throws on an unknown job key', () => {
    expect(() => loadRoutes({ ...json(), 'made.up': json()['news.impact'] }, {})).toThrow(/^ai-routes: .*made\.up/);
  });

  it('throws on a missing job', () => {
    const cfg: Record<string, unknown> = json();
    delete cfg['strategy.draft'];
    expect(() => loadRoutes(cfg, {})).toThrow(/^ai-routes: .*strategy\.draft/);
  });

  it('throws on a malformed route', () => {
    expect(() => loadRoutes({ ...json(), 'news.impact': { provider: 'claude-cli' } }, {})).toThrow(/^ai-routes: /);
    expect(() => loadRoutes(null, {})).toThrow(/^ai-routes: /);
  });

  it('ignores keys starting with "_" (comments)', () => {
    expect(() => loadRoutes({ _note: 'x', ...json() }, {})).not.toThrow();
  });

  it('loads the shipped config/ai-routes.json', () => {
    const raw = JSON.parse(fs.readFileSync(resolveAiConfig('ai-routes.json'), 'utf8'));
    const routes = loadRoutes(raw, {});
    expect(routes['decision.judge'].fallback).toEqual(['anthropic-api']);
  });

  it('news.* context jobs: claude-cli, Sonnet, no fallback (spec P4), priority 4', () => {
    const routes = loadRoutes(json(), {});
    for (const j of ['news.profile', 'news.audit', 'news.curate', 'news.label'] as const) {
      expect(routes[j]).toEqual(expect.objectContaining({ provider: 'claude-cli', model: 'claude-sonnet-5', fallback: [] }));
      expect(priorityOf(j)).toBe(4);
    }
  });
});

describe('resolveAiConfig', () => {
  const saved = process.env.AI_CONFIG_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.AI_CONFIG_DIR;
    else process.env.AI_CONFIG_DIR = saved;
  });

  it('walks up from the module to the repo config directory', () => {
    delete process.env.AI_CONFIG_DIR;
    const p = resolveAiConfig('ai-model-prices.json');
    expect(fs.existsSync(p)).toBe(true);
    expect(path.basename(path.dirname(p))).toBe('config');
  });

  it('honours AI_CONFIG_DIR', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-cfg-'));
    fs.writeFileSync(path.join(dir, 'ai-routes.json'), '{}');
    process.env.AI_CONFIG_DIR = dir;
    expect(resolveAiConfig('ai-routes.json')).toBe(path.join(dir, 'ai-routes.json'));
  });

  it('throws loudly when the file cannot be found', () => {
    delete process.env.AI_CONFIG_DIR;
    expect(() => resolveAiConfig('definitely-not-here.json')).toThrow(/definitely-not-here\.json/);
  });
});
