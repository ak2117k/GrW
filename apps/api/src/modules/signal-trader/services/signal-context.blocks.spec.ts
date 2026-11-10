import { SignalContextService } from './signal-context.service';
import { missingBlocks } from '../../self-review/decisions/detectors';

/**
 * Self-review ticket 2026-11-06 "judge packet built without the mbm block": every packet carried mbm as
 * `unavailable` (the owner's MBM_PACKET gate, or a non-NIFTY underlying) and CRUDEOIL's chain as
 * "nothing available (not wired, or no data)" — by-design absences read as data gaps by INPUT_MISSING.
 * By design ⇒ `not_applicable` with the reason; a chain snapshot carries its age so a days-old one is visible.
 */
const NOW = new Date('2026-11-06T08:59:06Z');

function make(o: { packet?: 'off' | 'observe' | 'on'; chain?: unknown } = {}) {
  const chain = { latestChain: jest.fn().mockResolvedValue(o.chain ?? null) };
  const mbm = { behaviour: jest.fn().mockResolvedValue({ status: 'ok', horizons: {} }) };
  const mbmCfg = { instruments: ['NIFTY'], packet: o.packet ?? 'observe' };
  const svc = new SignalContextService(chain as any, undefined, undefined, undefined, mbm as any, mbmCfg as any);
  return { svc, chain, mbm };
}

const build = (svc: SignalContextService, underlying: string, kind: string, exchange: string) =>
  svc.build({ underlying, kind, exchange, ownerUserId: 'owner', now: NOW, ltp: 100 });

describe('SignalContextService.build — by-design absences are explicit, not data gaps', () => {
  it('mbm on a non-MBM underlying (stock / MCX) is not_applicable with the reason', async () => {
    const { svc, mbm } = make({ packet: 'on' });
    for (const [u, k, ex] of [['MCX', 'CE', 'NFO'], ['CRUDEOIL', 'PE', 'MCX']]) {
      const ctx = await build(svc, u, k, ex);
      expect(ctx.mbm).toEqual({ status: 'not_applicable', reason: expect.stringContaining(`${u} is not an MBM instrument`) });
    }
    expect(mbm.behaviour).not.toHaveBeenCalled();
  });

  it('mbm withheld by the owner gate (MBM_PACKET != on) is not_applicable, naming the gate', async () => {
    const { svc } = make({ packet: 'observe' });
    const ctx = await build(svc, 'NIFTY', 'CE', 'NFO');
    expect(ctx.mbm).toEqual({ status: 'not_applicable', reason: expect.stringContaining('MBM_PACKET') });
  });

  it('mbm on NIFTY with the gate on is present', async () => {
    const { svc } = make({ packet: 'on' });
    const ctx = await build(svc, 'NIFTY', 'CE', 'NFO');
    expect(ctx.mbm.status).toBe('present');
  });

  it('chain on an MCX commodity is not_applicable (chain capture covers NFO underlyings only)', async () => {
    const { svc, chain } = make();
    const ctx = await build(svc, 'CRUDEOIL', 'PE', 'MCX');
    expect(ctx.chain).toEqual({ status: 'not_applicable', reason: expect.stringContaining('MCX') });
    expect(chain.latestChain).not.toHaveBeenCalled();
  });

  it('chain with no snapshot for an NFO underlying stays unavailable, with an explicit reason', async () => {
    const { svc } = make();
    const ctx = await build(svc, 'TIINDIA', 'CE', 'NFO');
    expect(ctx.chain).toEqual({ status: 'unavailable', reason: expect.stringContaining('no snapshot for TIINDIA') });
  });

  it('a present chain block carries its age in minutes', async () => {
    const capturedAt = new Date(NOW.getTime() - 2 * 86_400_000);
    const { svc } = make({ chain: { expiry: '2026-11-25', capturedAt, spot: 3500, fut: null, pcr: 1, maxPain: 3400, callWall: 3600, putWall: 3300 } });
    const ctx = await build(svc, 'MCX', 'CE', 'NFO');
    expect(ctx.chain.status).toBe('present');
    expect((ctx.chain as any).value.ageMin).toBe(2 * 24 * 60);
  });

  it('the night review (INPUT_MISSING) counts unavailable blocks but not not_applicable ones', async () => {
    const { svc } = make({ packet: 'observe' });
    const ctx = await build(svc, 'CRUDEOIL', 'PE', 'MCX');
    const miss = missingBlocks('judge', ctx);
    expect(miss).not.toContain('mbm');
    expect(miss).not.toContain('chain');
  });
});
