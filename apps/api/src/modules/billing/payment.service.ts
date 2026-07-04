import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { Seg } from './billing.service';

export interface PaymentView {
  id: string;
  segment: string | null;
  amount: number;
  currency: string;
  status: string;
  providerPaymentId: string;
  invoiceUrl: string | null;
  description: string | null;
  createdAt: string;
}

/**
 * TDA-017 — the per-transaction payment ledger. `record` is called by the
 * billing webhook worker (no tenant context) → runWithoutTenant; idempotent on
 * providerPaymentId (a redelivered charge is a no-op). `listForUser` serves the
 * authenticated /api/me/billing/payments surface.
 */
@Injectable()
export class PaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
  ) {}

  async record(input: {
    userId: string;
    segment: Seg | null;
    amount: number;
    status: 'CAPTURED' | 'FAILED' | 'REFUNDED';
    providerPaymentId: string;
    providerInvoiceId?: string | null;
    invoiceUrl?: string | null;
    description?: string | null;
  }): Promise<void> {
    await this.tenant.runWithoutTenant(async () => {
      try {
        await this.prisma.payment.create({
          data: {
            userId: input.userId,
            segment: input.segment ?? null,
            amount: input.amount,
            status: input.status,
            providerPaymentId: input.providerPaymentId,
            providerInvoiceId: input.providerInvoiceId ?? null,
            invoiceUrl: input.invoiceUrl ?? null,
            description: input.description ?? null,
          },
        });
      } catch (err) {
        // Idempotent: a duplicate providerPaymentId (redelivered webhook) is a no-op.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return;
        throw err;
      }
    });
  }

  async listForUser(userId: string): Promise<PaymentView[]> {
    const rows = await this.prisma.payment.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      segment: r.segment,
      amount: r.amount,
      currency: r.currency,
      status: r.status,
      providerPaymentId: r.providerPaymentId,
      invoiceUrl: r.invoiceUrl,
      description: r.description,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
