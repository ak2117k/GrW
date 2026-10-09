import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('./api', () => ({ default: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }));

import api from './api';
import { approveCoreVersion, listCoreSelections, listCoreStrategies, setCoreSelection } from './coreStrategies';

describe('coreStrategies wire client', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the catalogue and the caller’s selections from the kebab-case routes', async () => {
    (api.get as Mock).mockResolvedValueOnce({ data: { strategies: [{ id: 's1' }] } });
    expect(await listCoreStrategies()).toEqual([{ id: 's1' }]);
    expect(api.get).toHaveBeenLastCalledWith('/trade-core/strategies');
    (api.get as Mock).mockResolvedValueOnce({ data: { selections: [{ id: 'sel_1' }] } });
    expect(await listCoreSelections()).toEqual([{ id: 'sel_1' }]);
    expect(api.get).toHaveBeenLastCalledWith('/trade-core/strategy-selections');
  });

  it('PUTs a selection by strategy id (encoded) and POSTs an approval', async () => {
    (api.put as Mock).mockResolvedValueOnce({ data: { id: 'sel_1' } });
    const body = { strategyVersionId: 'v1', enabled: true, capitalAllocation: 1000 };
    await setCoreSelection('s/1', body);
    expect(api.put).toHaveBeenCalledWith('/trade-core/strategy-selections/s%2F1', body);
    (api.post as Mock).mockResolvedValueOnce({ data: { id: 'v1', status: 'PAPER' } });
    expect(await approveCoreVersion('v1')).toEqual({ id: 'v1', status: 'PAPER' });
    expect(api.post).toHaveBeenCalledWith('/trade-core/strategy-versions/v1/approve');
  });
});
