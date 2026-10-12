import type { ModuleRef } from '@nestjs/core';
import type { PaperOrderSquareOff } from '../execution/paper-order-square-off';
import { CoreSquareOff } from './core-square-off';
import { CORE_POSITION_EXITS } from './lifecycle-ports';

function setup(opts: { entriesFail?: boolean; exitsFail?: boolean } = {}) {
  const entries = {
    squareOffAll: opts.entriesFail
      ? jest.fn().mockRejectedValue(new Error('db down'))
      : jest.fn().mockResolvedValue({ cancelledOrders: 2, exitsRequested: 0, detail: '2 pending core entry order(s) cancelled' }),
  };
  const exits = { exitAll: opts.exitsFail ? jest.fn().mockRejectedValue(new Error('requested 0 of 1 core position exits')) : jest.fn().mockResolvedValue({ exitsRequested: 3 }) };
  const moduleRef = { get: jest.fn().mockReturnValue(exits) };
  const sq = new CoreSquareOff(entries as unknown as PaperOrderSquareOff, moduleRef as unknown as ModuleRef);
  return { entries, exits, moduleRef, sq };
}

describe('CoreSquareOff (CORE_SQUARE_OFF, spec §5.3/§5.4)', () => {
  it('cancels pending entry orders first, then exits every position, and reports both', async () => {
    const { entries, exits, sq } = setup();
    expect(await sq.squareOffAll('user_A', 'KILL_SWITCH', 'stop')).toEqual({
      cancelledOrders: 2,
      exitsRequested: 3,
      detail: '2 pending core entry order(s) cancelled; 3 core position exit(s) requested',
    });
    expect(entries.squareOffAll).toHaveBeenCalledWith('user_A', 'KILL_SWITCH', 'stop');
    expect(exits.exitAll).toHaveBeenCalledWith('user_A', 'KILL_SWITCH', 'stop');
    expect(entries.squareOffAll.mock.invocationCallOrder[0]).toBeLessThan(exits.exitAll.mock.invocationCallOrder[0]);
  });

  it('resolves the lifecycle lazily, at call time (ruling L14)', async () => {
    const { moduleRef, sq } = setup();
    expect(moduleRef.get).not.toHaveBeenCalled();
    await sq.squareOffAll('user_A', 'DAILY_LOSS', 'limit');
    expect(moduleRef.get).toHaveBeenCalledWith(CORE_POSITION_EXITS, { strict: false });
  });

  it('a failed cancellation still requests the exits, then fails the step (never a silent partial OK)', async () => {
    const { exits, sq } = setup({ entriesFail: true });
    await expect(sq.squareOffAll('user_A', 'KILL_SWITCH', 'stop')).rejects.toThrow('entry orders: db down');
    expect(exits.exitAll).toHaveBeenCalled();
  });

  it('a failed exit fails the step', async () => {
    const { sq } = setup({ exitsFail: true });
    await expect(sq.squareOffAll('user_A', 'KILL_SWITCH', 'stop')).rejects.toThrow('positions: requested 0 of 1 core position exits');
  });
});
