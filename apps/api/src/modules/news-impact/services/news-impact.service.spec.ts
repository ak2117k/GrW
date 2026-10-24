import { SessionClock } from '../../market-hub/session-clock';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { AssistBusyError } from '../../ai-assist/assist-slot';
import { __resetOpsAlerts } from '../../../common/utils/ops-alert';
import { parseNewsImpactConfig } from '../news-impact.config';
import { NEWS_IMPACT_HIGH_EVENT } from '../news-impact.ports';
import type { ClusterForImpact } from '../domain/impact';
import { NewsImpactService } from './news-impact.service';

const NOW = new Date('2026-10-23T05:30:00Z'); // Fri 11:00 IST, NSE trading day
const clock = new SessionClock({ holidays: MARKET_HOLIDAYS });

function cluster(id: string, o: Partial<ClusterForImpact> = {}): ClusterForImpact {
  return {
    id, headline: `Headline ${id}`, instruments: ['TCS'], sectors: [], indices: [], sources: ['Economic Times'], sourceCount: 1,
    firstSeen: new Date(NOW.getTime() - 30 * 60_000), lastSeen: new Date(NOW.getTime() - 20 * 60_000),
    materialType: 'NEWS', material: false, boilerplate: false, relevance: 0.8, reasons: [], impactAttempts: 0, analysedSourceCount: null, ...o,
  };
}

function setup(o: { clusters?: ClusterForImpact[]; used?: number; reply?: unknown; llmError?: Error; held?: string[]; env?: Record<string, string> } = {}) {
  const alerted = new Set<string>();
  const repo = {
    lastAiCallAt: jest.fn(async () => null),
    aiCallsSince: jest.fn(async () => o.used ?? 0),
    impactCandidates: jest.fn(async () => o.clusters ?? [cluster('c1')]),
    clusterTexts: jest.fn(async () => new Map()),
    bumpAttempts: jest.fn(async () => undefined),
    upsertImpact: jest.fn(async (i: { clusterId: string }) => ({ id: `imp-${i.clusterId}`, alertedAt: alerted.has(i.clusterId) ? new Date() : null })),
    setClusterSentiment: jest.fn(async () => 1),
    createReaction: jest.fn(async () => undefined),
    heldUnderlyings: jest.fn(async () => new Set(o.held ?? ['TCS'])),
    markAlerted: jest.fn(async (id: string) => {
      const c = id.replace('imp-', '');
      if (alerted.has(c)) return false;
      alerted.add(c);
      return true;
    }),
  };
  const llm = { analyse: jest.fn(async () => { if (o.llmError) throw o.llmError; return o.reply; }) };
  const events = { emit: jest.fn() };
  const cfg = parseNewsImpactConfig({ NEWS_IMPACT_DAILY_CALLS: '60', ...(o.env ?? {}) });
  const svc = new NewsImpactService(repo as never, cfg, clock, llm, events as never);
  return { svc, repo, llm, events };
}

const item = (clusterId: string, o: Record<string, unknown> = {}) => ({
  clusterId, direction: 'BEAR', magnitude: 'HIGH', horizon: 'INTRADAY',
  affected: { symbols: ['TCS'], sectors: ['IT'], index: null }, pricedIn: false, confidence: 0.8, oneLine: 'Guidance cut.', ...o,
});

beforeEach(() => __resetOpsAlerts());

describe('NewsImpactService — batched layer 2', () => {
  it('one call for the batch; stores impacts, sets article sentiment, records reactions', async () => {
    const { svc, repo, llm } = setup({ clusters: [cluster('c1'), cluster('c2')], reply: { items: [item('c1', { magnitude: 'MED' }), item('c2', { direction: 'BULL', magnitude: 'LOW' })] } });
    const r = await svc.run(NOW);
    expect(r).toMatchObject({ ran: true, sent: 2, stored: 2 });
    expect(llm.analyse).toHaveBeenCalledTimes(1);
    expect(repo.setClusterSentiment).toHaveBeenCalledWith('c1', 'bearish', -0.48);
    expect(repo.createReaction).toHaveBeenCalledWith(expect.objectContaining({ clusterId: 'c1', symbol: 'TCS', kind: 'STOCK', judgeSession: '2026-10-23', anchorIsOpen: false }));
  });

  it('respects the daily cap (counted from ai_calls) and makes no call', async () => {
    const { svc, llm } = setup({ used: 60, reply: { items: [] } });
    expect(await svc.run(NOW)).toMatchObject({ ran: false, reason: 'daily cap 60 reached' });
    expect(llm.analyse).not.toHaveBeenCalled();
  });

  it('nothing eligible → no call', async () => {
    const { svc, llm } = setup({ clusters: [cluster('c1', { boilerplate: true })] });
    await svc.run(NOW);
    expect(llm.analyse).not.toHaveBeenCalled();
  });

  it('clusters the model skipped get an attempt bumped (given up after 2)', async () => {
    const { svc, repo } = setup({ clusters: [cluster('c1'), cluster('c2')], reply: { items: [item('c1')] } });
    await svc.run(NOW);
    expect(repo.bumpAttempts).toHaveBeenLastCalledWith(['c2']);
  });

  it('busy shared slot: skipped without counting attempts', async () => {
    const { svc, repo } = setup({ llmError: new AssistBusyError(60_000) });
    expect(await svc.run(NOW)).toMatchObject({ reason: 'busy' });
    expect(repo.bumpAttempts).not.toHaveBeenCalled();
  });

  it('outside the session the cadence is 2 h from the last call', async () => {
    const evening = new Date('2026-10-23T13:30:00Z'); // 19:00 IST
    const { svc, llm } = setup({ reply: { items: [] } });
    await svc.run(evening);
    await svc.run(new Date(evening.getTime() + 15 * 60_000));
    expect(llm.analyse).toHaveBeenCalledTimes(1);
    await svc.run(new Date(evening.getTime() + 2 * 3_600_000));
    expect(llm.analyse).toHaveBeenCalledTimes(2);
  });
});

describe('NewsImpactService — HIGH impact wake + alert', () => {
  it('emits news.impact.high once per cluster for a held symbol', async () => {
    const { svc, events } = setup({ reply: { items: [item('c1')] } });
    await svc.run(NOW);
    expect(events.emit).toHaveBeenCalledWith(NEWS_IMPACT_HIGH_EVENT, expect.objectContaining({ clusterId: 'c1', targets: ['TCS'], magnitude: 'HIGH' }));
    // Re-analysed (coverage doubled): already alerted → no second event.
    await svc.run(new Date(NOW.getTime() + 15 * 60_000));
    expect(events.emit).toHaveBeenCalledTimes(1);
  });

  it('a HIGH index call alerts even when no stock is held; an unheld stock does not', async () => {
    const idx = setup({ held: [], reply: { items: [item('c1', { affected: { symbols: [], sectors: [], index: 'NIFTY' } })] } });
    await idx.svc.run(NOW);
    expect(idx.events.emit).toHaveBeenCalledWith(NEWS_IMPACT_HIGH_EVENT, expect.objectContaining({ targets: ['NIFTY'] }));
    const unheld = setup({ held: [], reply: { items: [item('c1')] } });
    await unheld.svc.run(NOW);
    expect(unheld.events.emit).not.toHaveBeenCalled();
  });

  it('NEWS_IMPACT_ALERTS=false: no event', async () => {
    const { svc, events } = setup({ reply: { items: [item('c1')] }, env: { NEWS_IMPACT_ALERTS: 'false' } });
    await svc.run(NOW);
    expect(events.emit).not.toHaveBeenCalled();
  });
});
