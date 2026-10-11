import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY, type AuthenticatedUser } from '../../../../common/decorators';
import type { CorePaperDefaultsService } from '../services/core-paper-defaults.service';
import { CorePaperDefaultsController } from './core-paper-defaults.controller';

const OWNER: AuthenticatedUser = { userId: 'usr_owner', role: 'ADMIN', email: 'o@x' };

describe('CorePaperDefaultsController', () => {
  it('serves /api/trade-core/paper/defaults, the whole controller @AdminOnly', () => {
    expect(Reflect.getMetadata(PATH_METADATA, CorePaperDefaultsController)).toBe('api/trade-core/paper/defaults');
    expect(Reflect.getMetadata(ROLES_KEY, CorePaperDefaultsController)).toEqual(['ADMIN']);
    expect(Reflect.getMetadata(METHOD_METADATA, CorePaperDefaultsController.prototype.list)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(METHOD_METADATA, CorePaperDefaultsController.prototype.change)).toBe(RequestMethod.PUT);
    expect(Reflect.getMetadata(PATH_METADATA, CorePaperDefaultsController.prototype.change)).toBe(':key/:scope');
  });

  it('passes the token user as the actor', async () => {
    const svc = { list: jest.fn().mockResolvedValue([]), change: jest.fn().mockResolvedValue({}) };
    const controller = new CorePaperDefaultsController(svc as unknown as CorePaperDefaultsService);
    expect(await controller.list()).toEqual({ defaults: [] });
    await controller.change(OWNER, 'slippageBps', 'MTF', { value: 3, reason: 'tighter fills' });
    expect(svc.change).toHaveBeenCalledWith({ userId: 'usr_owner', role: 'ADMIN' }, { key: 'slippageBps', scope: 'MTF', value: 3, reason: 'tighter fills' });
  });
});
