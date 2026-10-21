import { parseExitDisciplineConfig } from '../../exit-discipline/config';
import { ExitGateService } from './exit-gate.service';

const NOW = new Date('2026-10-14T11:01:20Z');
const make = (tuning?: { get: (t: string, d: unknown) => unknown }) =>
  new ExitGateService({} as never, { minutesToClose: () => 100 } as never, parseExitDisciplineConfig({}), undefined, undefined, tuning as never);

describe('ExitGateService — self-review tuning', () => {
  it('uses the env config without a tuning reader', () => {
    const r = make().decide({ kind: 'unreadable', reason: 'x' }, { ltpNow: 1, productType: null, exchange: 'NFO', now: NOW });
    expect(r.cfg.persistMinSec).toBe(120);
  });

  it('an approved persistMinSec override is what the decision records', () => {
    const tuning = { get: (t: string, d: unknown) => (t === 'exit.persistMinSec' ? 240 : d) };
    const r = make(tuning).decide({ kind: 'unreadable', reason: 'x' }, { ltpNow: 1, productType: null, exchange: 'NFO', now: NOW });
    expect(r.cfg.persistMinSec).toBe(240);
  });

  it('an out-of-bounds override is ignored', () => {
    const tuning = { get: (t: string, d: unknown) => (t === 'exit.persistMinSec' ? 5000 : d) };
    const r = make(tuning).decide({ kind: 'unreadable', reason: 'x' }, { ltpNow: 1, productType: null, exchange: 'NFO', now: NOW });
    expect(r.cfg.persistMinSec).toBe(120);
  });
});
