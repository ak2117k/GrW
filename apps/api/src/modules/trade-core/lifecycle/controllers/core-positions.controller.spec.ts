import { NotFoundException } from '@nestjs/common';
import { validate } from 'class-validator';
import type { AuditService } from '../../../../common/audit/audit.service';
import { AUDIT_ACTIONS } from '../../../../common/audit/audit-actions';
import type { CoreLifecycleService } from '../core-lifecycle.service';
import { ExitPositionDto } from '../dto/core-position.dto';
import { CorePositionsController } from './core-positions.controller';

function setup() {
  const lifecycle = {
    positionsFor: jest.fn().mockResolvedValue([{ id: 'pos_1' }]),
    requestExit: jest.fn().mockResolvedValue({ id: 'pos_1', status: 'EXITING' }),
  };
  const audit = { append: jest.fn().mockResolvedValue({ seq: 1n, hash: 'h' }) };
  const c = new CorePositionsController(lifecycle as unknown as CoreLifecycleService, audit as unknown as AuditService);
  return { lifecycle, audit, c };
}

describe('CorePositionsController (ruling L18)', () => {
  it("lists the caller's active positions and those closed in the last 7 days", async () => {
    const { lifecycle, c } = setup();
    const before = Date.now();
    expect(await c.list('user_A')).toEqual({ positions: [{ id: 'pos_1' }] });
    const [userId, since] = lifecycle.positionsFor.mock.calls[0] as [string, Date];
    expect(userId).toBe('user_A');
    expect(before - since.getTime()).toBeGreaterThanOrEqual(7 * 86_400_000 - 1000);
  });

  it("a manual exit is the caller's own, with the trimmed reason, and audited", async () => {
    const { lifecycle, audit, c } = setup();
    expect(await c.exit('user_A', 'pos_1', { reason: '  too risky  ' })).toEqual({ position: { id: 'pos_1', status: 'EXITING' } });
    expect(lifecycle.requestExit).toHaveBeenCalledWith('user_A', 'pos_1', 'MANUAL', 'too risky');
    expect(audit.append).toHaveBeenCalledWith({
      action: AUDIT_ACTIONS.lifecycle.CORE_POSITION_EXIT_REQUESTED,
      userId: 'user_A',
      target: 'core_positions:pos_1',
      meta: { reason: 'too risky', status: 'EXITING' },
    });
  });

  it('an audit failure never fails the exit', async () => {
    const { audit, c } = setup();
    audit.append.mockRejectedValueOnce(new Error('audit down'));
    await expect(c.exit('user_A', 'pos_1', { reason: 'too risky' })).resolves.toMatchObject({ position: { id: 'pos_1' } });
  });

  it("another user's position is the service's 404", async () => {
    const { lifecycle, c } = setup();
    lifecycle.requestExit.mockRejectedValueOnce(new NotFoundException('active core position pos_1 not found'));
    await expect(c.exit('user_B', 'pos_1', { reason: 'not mine' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('the body must say why', async () => {
    expect(await validate(Object.assign(new ExitPositionDto(), { reason: '  ' }))).toHaveLength(1);
    expect(await validate(Object.assign(new ExitPositionDto(), { reason: 'thesis broken' }))).toHaveLength(0);
  });
});
