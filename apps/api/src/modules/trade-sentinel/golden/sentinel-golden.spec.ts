import { spawn } from 'node:child_process';
import {
  CLI_SCENARIO_NAMES,
  SCENARIO_NAMES,
  recordingClient,
  runCliGoldenScenarios,
  runGoldenScenarios,
} from './golden-fixtures';

// Only `spawn` is replaced: @prisma/client (reached through ThesisService's
// repository import) promisifies other child_process functions at load time.
jest.mock('node:child_process', () => ({
  ...jest.requireActual<typeof import('node:child_process')>('node:child_process'),
  spawn: jest.fn(),
}));
const spawnMock = spawn as unknown as jest.Mock;

/**
 * SP3 §4.7 behaviour-preservation contract. The snapshots were recorded against
 * the pre-gateway sentinel and must NOT be updated to make a later change pass:
 * a diff here is a change in what the live sentinel sends or how it parses.
 */
describe('sentinel golden characterisation (pre-gateway baseline)', () => {
  it('matches the recorded baseline for every scenario', async () => {
    const records = await runGoldenScenarios((rec) => recordingClient(rec));
    for (const r of records) expect(r).toMatchSnapshot(r.scenario);
  });

  it('covers every scenario name exactly once', async () => {
    const records = await runGoldenScenarios((rec) => recordingClient(rec));
    expect(records.map((r) => r.scenario).sort()).toEqual([...SCENARIO_NAMES].sort());
  });
});

describe('sentinel golden characterisation — claude CLI transport', () => {
  it('matches the recorded baseline for every CLI scenario', async () => {
    const records = await runCliGoldenScenarios(spawnMock);
    for (const r of records) expect(r).toMatchSnapshot(r.scenario);
  });

  it('covers every CLI scenario name exactly once', async () => {
    const records = await runCliGoldenScenarios(spawnMock);
    expect(records.map((r) => r.scenario).sort()).toEqual([...CLI_SCENARIO_NAMES].sort());
  });
});
