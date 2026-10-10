import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY, type AuthenticatedUser } from '../../../../common/decorators';
import type { CoreRiskDefaultsService } from '../services/core-risk-defaults.service';
import { CoreRiskDefaultsController } from './core-risk-defaults.controller';

const OWNER: AuthenticatedUser = { userId: 'usr_owner', role: 'ADMIN', email: 'o@x' };

describe('CoreRiskDefaultsController', () => {
  it('serves /api/trade-core/risk/defaults, the whole controller @AdminOnly', () => {
    expect(Reflect.getMetadata(PATH_METADATA, CoreRiskDefaultsController)).toBe('api/trade-core/risk/defaults');
    expect(Reflect.getMetadata(ROLES_KEY, CoreRiskDefaultsController)).toEqual(['ADMIN']);
    expect(Reflect.getMetadata(METHOD_METADATA, CoreRiskDefaultsController.prototype.list)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(METHOD_METADATA, CoreRiskDefaultsController.prototype.change)).toBe(RequestMethod.PUT);
    expect(Reflect.getMetadata(PATH_METADATA, CoreRiskDefaultsController.prototype.change)).toBe(':key/:scope');
  });

  it('passes the token user as the actor', async () => {
    const svc = { list: jest.fn().mockResolvedValue([]), change: jest.fn().mockResolvedValue({}) };
    const controller = new CoreRiskDefaultsController(svc as unknown as CoreRiskDefaultsService);
    expect(await controller.list()).toEqual({ defaults: [] });
    await controller.change(OWNER, 'maxTradesPerDay', 'ALL', { value: 12, reason: 'fewer trades' });
    expect(svc.change).toHaveBeenCalledWith({ userId: 'usr_owner', role: 'ADMIN' }, { key: 'maxTradesPerDay', scope: 'ALL', value: 12, reason: 'fewer trades' });
  });
});
