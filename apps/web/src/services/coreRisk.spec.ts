import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('./api', () => ({ default: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }));

import api from './api';
import { changeCoreRiskLimit, getCoreKillSwitch, listCoreRiskLimits, setCoreKillSwitch } from './coreRisk';

describe('coreRisk wire client', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the caller’s limits and kill switch from the kebab-case routes', async () => {
    (api.get as Mock).mockResolvedValueOnce({ data: { limits: [{ key: 'maxDailyLoss' }] } });
    expect(await listCoreRiskLimits()).toEqual([{ key: 'maxDailyLoss' }]);
    expect(api.get).toHaveBeenLastCalledWith('/trade-core/risk/limits');
    (api.get as Mock).mockResolvedValueOnce({ data: { active: false } });
    expect(await getCoreKillSwitch()).toEqual({ active: false });
    expect(api.get).toHaveBeenLastCalledWith('/trade-core/risk/kill-switch');
  });

  it('PUTs a limit change by key and scope (encoded) and POSTs the kill switch with a long timeout', async () => {
    (api.put as Mock).mockResolvedValueOnce({ data: { direction: 'TIGHTER' } });
    await changeCoreRiskLimit('maxOpenPositions', 'OPTIONS/BUY', { value: 2, reason: 'fewer' });
    expect(api.put).toHaveBeenCalledWith('/trade-core/risk/limits/maxOpenPositions/OPTIONS%2FBUY', { value: 2, reason: 'fewer' });
    (api.post as Mock).mockResolvedValueOnce({ data: { cascade: null } });
    await setCoreKillSwitch({ active: true, reason: 'stop' });
    expect(api.post).toHaveBeenCalledWith('/trade-core/risk/kill-switch', { active: true, reason: 'stop' }, { timeout: 120_000 });
  });
});
