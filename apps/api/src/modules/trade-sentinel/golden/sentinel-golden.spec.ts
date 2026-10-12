import { spawn } from 'node:child_process';
import {
  CLI_SCENARIO_NAMES,
  SCENARIO_NAMES,
  cleanupCliTempDirs,
  defaultCliTransport,
  expectCliSameAsBaseline,
  expectSameAsBaseline,
  recordingClient,
  runCliGoldenScenarios,
  runGoldenScenarios,
  type GoldenRecord,
} from './golden-fixtures';
import { AiGatewayService } from '../../ai-gateway/ai-gateway.service';
import type { AiCallRow } from '../../ai-gateway/audit/ai-call.repository';
import { BudgetMeter } from '../../ai-gateway/budget/budget-meter';
import { loadPrices } from '../../ai-gateway/budget/model-prices';
import { AnthropicApiProvider } from '../../ai-gateway/providers/anthropic-api.provider';
import { ClaudeCliProvider, ClaudeCliTransport } from '../../ai-gateway/providers/claude-cli.provider';
import type { ProviderAdapter, ProviderName } from '../../ai-gateway/providers/provider.types';
import { loadRoutes, readAiConfig } from '../../ai-gateway/routes/route-config';
import { PriorityScheduler } from '../../ai-gateway/scheduler/priority-scheduler';
import { SentinelGatewayTransport } from '../../ai-gateway/sentinel/sentinel-gateway.transport';
import type { MessagesTransport, TransportRequest } from '../services/llm-transport';

// Only `spawn` is replaced: @prisma/client (reached through ThesisService's
// repository import) promisifies other child_process functions at load time.
jest.mock('node:child_process', () => ({
  ...jest.requireActual<typeof import('node:child_process')>('node:child_process'),
  spawn: jest.fn(),
}));
const spawnMock = spawn as unknown as jest.Mock;

afterAll(() => cleanupCliTempDirs());

/**
 * SP3 §4.7 behaviour-preservation contract. The snapshots were recorded against
 * the pre-gateway sentinel and must NOT be updated to make a later change pass:
 * a diff here is a change in what the live sentinel sends or how it parses.
 *
 * Snapshot keys include these describe/test titles — do not rename them. A
 * consumer in another describe compares through `expectSameAsBaseline` /
 * `expectCliSameAsBaseline`, never through its own `toMatchSnapshot`.
 */
describe('sentinel golden characterisation (pre-gateway baseline)', () => {
  let records: GoldenRecord[];
  beforeAll(async () => {
    records = await runGoldenScenarios((rec) => recordingClient(rec));
  });

  it('matches the recorded baseline for every scenario', () => {
    for (const r of records) expect(r).toMatchSnapshot(r.scenario);
  });

  it('covers every scenario name exactly once', () => {
    expect(records.map((r) => r.scenario).sort()).toEqual([...SCENARIO_NAMES].sort());
  });

  it('expectSameAsBaseline accepts the baseline client itself (self-check)', async () => {
    await expectSameAsBaseline((rec) => recordingClient(rec));
  });
});

describe('sentinel golden characterisation — claude CLI transport', () => {
  let records: GoldenRecord[];
  beforeAll(async () => {
    records = await runCliGoldenScenarios(spawnMock);
  });

  it('matches the recorded baseline for every CLI scenario', () => {
    for (const r of records) expect(r).toMatchSnapshot(r.scenario);
  });

  it('covers every CLI scenario name exactly once', () => {
    expect(records.map((r) => r.scenario).sort()).toEqual([...CLI_SCENARIO_NAMES].sort());
  });

  it('expectCliSameAsBaseline accepts the production transport itself (self-check)', async () => {
    await expectCliSameAsBaseline(spawnMock, defaultCliTransport);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SP3 A6 — the same scenarios through the AI gateway (AI_GATEWAY_SENTINEL=true)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A REAL gateway as the module wires it: routes from the shipped
 * `config/ai-routes.json`, prices from the shipped `config/ai-model-prices.json`
 * (plus the golden suite's override model `x-model`, which the shipped table
 * rightly does not price — an unpriced model is refused on the API), the
 * default ₹100 daily cap, the real scheduler and the real provider adapters.
 * Only the SDK client / `spawn` underneath and the audit repository are fakes.
 *
 * Compared through `expectSameAsBaseline` / `expectCliSameAsBaseline`, never
 * `toMatchSnapshot`: snapshot keys include the test title, so a snapshot call
 * here would WRITE new keys instead of comparing. The baseline is pinned by the
 * snapshots above, so equality is transitive.
 */
function realGateway(
  sentinelJudge: 'api' | 'cli',
  adapters: Partial<Record<ProviderName, ProviderAdapter>>,
  insert: (row: AiCallRow) => Promise<void>,
): AiGatewayService {
  const prices = loadPrices(readAiConfig('ai-model-prices.json'));
  prices.set('x-model', { inputPerMTokInr: 440, outputPerMTokInr: 2200 });
  return new AiGatewayService({
    routes: loadRoutes(readAiConfig('ai-routes.json'), { SENTINEL_JUDGE: sentinelJudge }),
    prices,
    meter: new BudgetMeter({ capInr: 100, reserveShare: 0.25, spentToday: async () => 0, now: () => new Date() }),
    scheduler: new PriorityScheduler({}),
    adapters,
    audit: { insert },
  });
}

/** The real API provider over the recording client (which throws unless called with exactly one argument). */
const apiOver = (rec: Parameters<typeof recordingClient>[0]): ProviderAdapter =>
  new AnthropicApiProvider(recordingClient(rec) as never);

/** The job each service-level scenario must be filed under in `ai_calls`. */
function expectedJob(scenario: string): string {
  if (scenario.startsWith('overnight')) return 'sentinel.overnight';
  if (scenario.startsWith('thesis')) return 'sentinel.thesis';
  return 'sentinel.judge';
}

const flushIo = () => new Promise((r) => setImmediate(r));

describe('through the gateway (AI_GATEWAY_SENTINEL=true)', () => {
  it('SENTINEL_JUDGE=api: identical records to the baseline, one ai_calls row per scenario under the right job', async () => {
    const audits: AiCallRow[][] = [];
    await expectSameAsBaseline((rec) => {
      const rows: AiCallRow[] = [];
      audits.push(rows);
      const gw = realGateway('api', { 'anthropic-api': apiOver(rec) }, async (row) => {
        rows.push(row);
      });
      return new SentinelGatewayTransport(gw);
    });
    await flushIo();
    expect(audits).toHaveLength(SCENARIO_NAMES.length);
    const filed = audits.map((rows, i) => ({
      scenario: SCENARIO_NAMES[i],
      rows: rows.length,
      job: rows[0]?.job,
      provider: rows[0]?.provider,
    }));
    expect(filed).toEqual(
      SCENARIO_NAMES.map((scenario) => ({ scenario, rows: 1, job: expectedJob(scenario), provider: 'anthropic-api' })),
    );
  });

  it('the provider receives the very object the sentinel built (so deep-equal, key order included)', async () => {
    const pairs: Array<{ built: TransportRequest; sent: TransportRequest | undefined }> = [];
    await runGoldenScenarios((rec): MessagesTransport => {
      const api = apiOver(rec);
      const send = jest.spyOn(api, 'send');
      const transport = new SentinelGatewayTransport(realGateway('api', { 'anthropic-api': api }, async () => undefined));
      return {
        messages: {
          create: async (params) => {
            try {
              return await transport.messages.create(params);
            } finally {
              pairs.push({ built: params, sent: send.mock.calls[0]?.[0] });
            }
          },
        },
      };
    });
    expect(pairs).toHaveLength(SCENARIO_NAMES.length);
    for (const p of pairs) {
      expect(p.sent).toBe(p.built);
    }
  });

  it('a throwing audit repository leaves verdicts, rows and logs identical; the gateway logs exactly one audit failure per scenario', async () => {
    const gatewayErrors: string[][] = [];
    await expectSameAsBaseline((rec) => {
      const gw = realGateway('api', { 'anthropic-api': apiOver(rec) }, () =>
        Promise.reject(new Error('ai_calls unavailable')),
      );
      const lines: string[] = [];
      gatewayErrors.push(lines);
      const logger = (gw as unknown as { logger: { error: (m: string) => void } }).logger;
      jest.spyOn(logger, 'error').mockImplementation((m: string) => {
        lines.push(m);
      });
      return new SentinelGatewayTransport(gw);
    });
    await flushIo();
    expect(gatewayErrors).toHaveLength(SCENARIO_NAMES.length);
    for (const lines of gatewayErrors) {
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^ai-gateway: audit write failed \(sentinel\.(judge|overnight|thesis)\): ai_calls unavailable$/);
    }
  });

  it('SENTINEL_JUDGE=cli: every CLI scenario is identical to the baseline through the gateway CLI provider', async () => {
    await expectCliSameAsBaseline(spawnMock, () =>
      new SentinelGatewayTransport(
        realGateway('cli', { 'claude-cli': new ClaudeCliProvider(new ClaudeCliTransport()) }, async () => undefined),
      ),
    );
  });
});
