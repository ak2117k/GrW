import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('./api', () => ({ default: { get: vi.fn(), put: vi.fn() } }));

import api from './api';
import { changeCoreRiskDefault, listCoreRiskDefaults } from './coreRiskDefaults';

describe('coreRiskDefaults wire client', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads and changes the seed defaults on the admin routes', async () => {
    (api.get as Mock).mockResolvedValueOnce({ data: { defaults: [{ key: 'maxTradesPerDay' }] } });
    expect(await listCoreRiskDefaults()).toEqual([{ key: 'maxTradesPerDay' }]);
    expect(api.get).toHaveBeenLastCalledWith('/trade-core/risk/defaults');
    (api.put as Mock).mockResolvedValueOnce({ data: { key: 'maxTradesPerDay', value: 12 } });
    await changeCoreRiskDefault('maxTradesPerDay', 'ALL', { value: 12, reason: 'fewer trades' });
    expect(api.put).toHaveBeenCalledWith('/trade-core/risk/defaults/maxTradesPerDay/ALL', { value: 12, reason: 'fewer trades' });
  });
});
