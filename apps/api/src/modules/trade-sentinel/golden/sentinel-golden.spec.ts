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
