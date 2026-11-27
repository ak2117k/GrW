import { Test } from '@nestjs/testing';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ExitAuthorityModule } from './exit-authority.module';
import { AUTHORITY_STATE, OWNER_ESCALATION, TRADE_ALARMS } from './exit-authority.tokens';
import { AuthorityStateService } from './services/authority-state.service';
import { EscalationRunner } from './services/escalation-runner.service';
import { TradeAlarmsService } from './services/trade-alarms.service';
import { OwnerButtonsService } from './telegram/owner-buttons.service';

describe('ExitAuthorityModule wiring', () => {
  async function build() {
    return Test.createTestingModule({ imports: [ExitAuthorityModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
  }

  it('AUTHORITY_STATE resolves inside the module and is injected into TradeAlarmsService', async () => {
    const mod = await build();
    const state = mod.get(AuthorityStateService);
    expect(mod.get(AUTHORITY_STATE)).toBe(state);
    const alarms = mod.get(TradeAlarmsService);
    expect((alarms as unknown as { state?: unknown }).state).toBe(state);
    expect(mod.get(TRADE_ALARMS)).toBe(alarms);
  });

  it('OWNER_ESCALATION is the owner buttons service; the runner resolves with every optional port absent', async () => {
    const mod = await build();
    expect(mod.get(OWNER_ESCALATION)).toBe(mod.get(OwnerButtonsService));
    expect(mod.get(EscalationRunner)).toBeInstanceOf(EscalationRunner);
  });

  it('off: raise() writes nothing (AUTHORITY_STATE bound but not live before / without the boot check)', async () => {
    const mod = await build();
    const alarms = mod.get(TradeAlarmsService);
    const row = await alarms.raise({
      userId: 'u',
      trackerId: 'trk',
      symbol: 'X',
      rule: 'FLOOR',
      urgency: 'normal',
      reason: 'r',
      wouldHave: 'w',
    });
    expect(row).toBeNull();
  });
});
