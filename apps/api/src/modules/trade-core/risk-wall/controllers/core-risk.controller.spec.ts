import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ROLES_KEY, type AuthenticatedUser } from '../../../../common/decorators';
import { ChangeLimitDto, SetKillSwitchDto } from '../dto/core-risk.dto';
import type { CoreKillSwitchService } from '../services/core-kill-switch.service';
import type { CoreRiskLimitService } from '../services/core-risk-limit.service';
import { CoreRiskController } from './core-risk.controller';

const USER_A: AuthenticatedUser = { userId: 'user_A', role: 'USER', email: 'a@x' };

function setup() {
  const limits = { list: jest.fn().mockResolvedValue([]), change: jest.fn().mockResolvedValue({ direction: 'TIGHTER' }) };
  const killSwitch = { get: jest.fn().mockResolvedValue({ active: false }), set: jest.fn().mockResolvedValue({ cascade: null }) };
  const controller = new CoreRiskController(limits as unknown as CoreRiskLimitService, killSwitch as unknown as CoreKillSwitchService);
  return { limits, killSwitch, controller };
}

const route = (m: keyof CoreRiskController) => ({
  path: Reflect.getMetadata(PATH_METADATA, CoreRiskController.prototype[m]) as string,
  method: Reflect.getMetadata(METHOD_METADATA, CoreRiskController.prototype[m]) as RequestMethod,
  roles: Reflect.getMetadata(ROLES_KEY, CoreRiskController.prototype[m]) as string[] | undefined,
});

describe('CoreRiskController', () => {
  it('serves /api/trade-core/risk; GET kill-switch reads and POST writes; no route is @AdminOnly', () => {
    expect(Reflect.getMetadata(PATH_METADATA, CoreRiskController)).toBe('api/trade-core/risk');
    expect(Reflect.getMetadata(ROLES_KEY, CoreRiskController)).toBeUndefined();
    expect(route('listLimits')).toEqual({ path: 'limits', method: RequestMethod.GET, roles: undefined });
    expect(route('changeLimit')).toEqual({ path: 'limits/:key/:scope', method: RequestMethod.PUT, roles: undefined });
    expect(route('getKillSwitch')).toEqual({ path: 'kill-switch', method: RequestMethod.GET, roles: undefined });
    expect(route('setKillSwitch')).toEqual({ path: 'kill-switch', method: RequestMethod.POST, roles: undefined });
  });

  it('POST kill-switch is never throttled (a safety press is never refused with 429)', () => {
    // @nestjs/throttler 6.x: @SkipThrottle() writes `THROTTLER:SKIP<name>` = true for the 'default' throttler.
    expect(Reflect.getMetadata('THROTTLER:SKIPdefault', CoreRiskController.prototype.setKillSwitch)).toBe(true);
    expect(Reflect.getMetadata('THROTTLER:SKIPdefault', CoreRiskController.prototype.changeLimit)).toBeUndefined();
  });

  it('routes take the user from the token, never from the path or body', async () => {
    const { limits, killSwitch, controller } = setup();
    await controller.listLimits('user_A');
    expect(limits.list).toHaveBeenCalledWith('user_A');
    await controller.changeLimit('user_A', 'maxDailyLoss', 'ALL', { value: 4000, reason: 'tighter', userId: 'user_B' } as unknown as ChangeLimitDto);
    expect(limits.change).toHaveBeenCalledWith('user_A', { key: 'maxDailyLoss', scope: 'ALL', value: 4000, reason: 'tighter' });
    await controller.setKillSwitch(USER_A, { active: true, reason: 'stop' });
    expect(killSwitch.set).toHaveBeenCalledWith({ userId: 'user_A', role: 'USER' }, { active: true, reason: 'stop' });
  });

  it('GET kill-switch only reads', async () => {
    const { killSwitch, controller } = setup();
    expect(await controller.getKillSwitch('user_A')).toEqual({ active: false });
    expect(killSwitch.get).toHaveBeenCalledWith('user_A');
    expect(killSwitch.set).not.toHaveBeenCalled();
  });
});

describe('request DTOs', () => {
  it('ChangeLimitDto takes a number or a short string, and a 3–500 character reason; it strips userId', async () => {
    const dto = plainToInstance(ChangeLimitDto, { value: 4000, reason: 'tighter', userId: 'user_B' });
    expect(await validate(dto, { whitelist: true })).toEqual([]);
    expect((dto as unknown as Record<string, unknown>).userId).toBeUndefined();
    for (const value of [4000, 0, 2.5, '15:00', 'BLOCK_ENTRIES']) {
      expect(await validate(plainToInstance(ChangeLimitDto, { value, reason: 'why not' }))).toEqual([]);
    }
    for (const value of [undefined, null, NaN, Infinity, true, {}, [], 'x'.repeat(33)]) {
      expect((await validate(plainToInstance(ChangeLimitDto, { value, reason: 'why not' }))).map((e) => e.property)).toEqual(['value']);
    }
    for (const reason of [undefined, '', '   ', 'ab', '  ab  ', 'x'.repeat(501), 42]) {
      expect((await validate(plainToInstance(ChangeLimitDto, { value: 1, reason }))).map((e) => e.property)).toEqual(['reason']);
    }
  });

  it('measures the reason after trimming, as the services store it', async () => {
    // Whitespace-only and padded-short reasons fail; the services only trim.
    for (const reason of ['      ', '\t\n ', '  a ', ' ab \n']) {
      expect((await validate(plainToInstance(ChangeLimitDto, { value: 1, reason }))).map((e) => e.property)).toEqual(['reason']);
      expect((await validate(plainToInstance(SetKillSwitchDto, { active: true, reason }))).map((e) => e.property)).toEqual(['reason']);
    }
    // 3 and 500 characters once trimmed are the bounds, padding aside.
    for (const reason of ['  abc  ', 'x'.repeat(500), `  ${'x'.repeat(500)}  `]) {
      expect(await validate(plainToInstance(ChangeLimitDto, { value: 1, reason }))).toEqual([]);
    }
    expect((await validate(plainToInstance(ChangeLimitDto, { value: 1, reason: ` ${'x'.repeat(501)} ` }))).map((e) => e.property)).toEqual(['reason']);
  });

  it('SetKillSwitchDto needs a real boolean and a reason', async () => {
    expect(await validate(plainToInstance(SetKillSwitchDto, { active: true, reason: 'stop now' }))).toEqual([]);
    expect((await validate(plainToInstance(SetKillSwitchDto, { active: 'true', reason: 'stop now' }))).map((e) => e.property)).toEqual(['active']);
    expect((await validate(plainToInstance(SetKillSwitchDto, { active: false }))).map((e) => e.property)).toEqual(['reason']);
  });
});
