import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UserStrategyDto } from './user-strategy.dto';

/**
 * Locks the wire contract the web Strategy Builder sends to POST
 * /api/strategies/save (apps/web/src/stores/strategy-builder-store.ts
 * toSavePayload). If this fails, the builder's Save button breaks.
 */
describe('UserStrategyDto — web builder save payload', () => {
  const builderPayload = {
    name: 'My ORB',
    description: 'd',
    code: '@strategy("My ORB")',
    type: 'visual',
    timeframes: ['5m'],
    segments: ['FUTURES'],
    parameters: {
      builder: {
        instrument: 'NIFTY',
        indicators: [{ id: 'i1', name: 'RSI', params: { period: 14 } }],
        entryRules: [{ id: 'r1', conditions: [], logic: 'AND' }],
        exitRules: [],
      },
    },
  };

  it('accepts the builder payload and keeps parameters.builder through whitelist', async () => {
    const dto = plainToInstance(UserStrategyDto, builderPayload);
    const errors = await validate(dto, { whitelist: true });
    expect(errors).toEqual([]);
    expect((dto.parameters as any).builder.instrument).toBe('NIFTY');
  });

  it('rejects the old broken shape (mode instead of type)', async () => {
    const { type: _t, ...rest } = builderPayload;
    const dto = plainToInstance(UserStrategyDto, { ...rest, mode: 'visual' });
    const errors = await validate(dto, { whitelist: true });
    expect(errors.map((e) => e.property)).toContain('type');
  });
});
