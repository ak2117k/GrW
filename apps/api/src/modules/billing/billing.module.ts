import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { TenantModule } from '../../common/tenant/tenant.module';
import { SecretsModule } from '../../common/secrets/secrets.module';
import {
  SECRETS_PROVIDER,
  SecretsProvider,
} from '../../common/secrets/secrets-provider.interface';
import { SubscriptionModule } from '../subscription/subscription.module';
import { BillingService } from './billing.service';
import { BillingWebhookService } from './billing-webhook.service';
import { BillingSweepService } from './billing-sweep.service';
import { MeBillingController } from './me-billing.controller';
import { RazorpayWebhookController } from './razorpay-webhook.controller';
import {
  PAYMENT_PROVIDER,
  PaymentProvider,
} from './providers/payment-provider.interface';
import { FakePaymentProvider } from './providers/fake-payment.provider';

/**
 * Config-selected {@link PaymentProvider} factory (mirrors the TDA-004
 * SecretsProvider factory). `billing.provider === 'razorpay'` (prod/dev default)
 * dynamically imports the `RazorpayProvider` so the offline test build never
 * needs the `razorpay` SDK; anything else yields the {@link FakePaymentProvider}.
 */
export async function paymentProviderFactory(
  config: ConfigService,
  secrets: SecretsProvider,
): Promise<PaymentProvider> {
  const kind = config.get<string>('billing.provider', 'razorpay');
  if (kind === 'razorpay') {
    // Dynamic import so razorpay.provider (and its dynamic `razorpay` SDK) is
    // never pulled into the fake/test path.
    const { RazorpayProvider } = await import('./providers/razorpay.provider');
    return new RazorpayProvider(secrets);
  }
  return new FakePaymentProvider();
}

/**
 * Billing / payments module (TDA-015). `@Global` so `BillingService` is
 * injectable app-wide (mirrors SubscriptionModule's shape). Imports
 * SubscriptionModule for the ONLY entitlement writer (`SubscriptionService`),
 * plus Prisma/Tenant/Secrets.
 */
@Global()
@Module({
  imports: [PrismaModule, TenantModule, SecretsModule, SubscriptionModule],
  controllers: [MeBillingController, RazorpayWebhookController],
  providers: [
    {
      provide: PAYMENT_PROVIDER,
      useFactory: paymentProviderFactory,
      inject: [ConfigService, SECRETS_PROVIDER],
    },
    BillingService,
    BillingWebhookService,
    BillingSweepService,
  ],
  exports: [BillingService, BillingWebhookService, PAYMENT_PROVIDER],
})
export class BillingModule {}
