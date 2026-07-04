import { MeBillingController } from '../../src/modules/billing/me-billing.controller';

it('GET payments returns the caller payments from the service', async () => {
  const listForUser = jest.fn().mockResolvedValue([{ id: 'p1', providerPaymentId: 'pay_1' }]);
  const controller = new MeBillingController({} as never, { listForUser } as never);
  const res = await controller.payments({ userId: 'usr_1', email: 'a@b.c' } as never);
  expect(listForUser).toHaveBeenCalledWith('usr_1');
  expect(res).toEqual([{ id: 'p1', providerPaymentId: 'pay_1' }]);
});
