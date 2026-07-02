import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { AuditService } from '../../common/audit/audit.service';
import { canonicalize, sha256 } from '../../common/audit/canonicalize';
import { RISK_DISCLOSURE } from './consent.constants';

/** The active disclosure a USER is asked to accept (spec §4). */
export interface CurrentConsent {
  documentId: string;
  kind: string;
  version: string;
  body: string;
  contentHash: string; // 'sha256:…'
  createdAt: Date;
}

/** The consent status /status and the UI need (spec §4). */
export interface ConsentStatus {
  currentVersion: string | null; // null if no active doc (fail-closed)
  accepted: boolean; // accepted the CURRENT version?
  acceptedVersion: string | null; // the version the user last accepted, if any
  requiresReconsent: boolean; // accepted an older version but not the current
}

/**
 * TDA-009 versioned consent & disclaimer gate (spec §4).
 *
 * The single owner of the consent content hash and the only writer of
 * `ConsentDocument`/`ConsentRecord`. "Current version" = the single `active`
 * `ConsentDocument` for a `kind`; acceptance is pinned to that document's **id**
 * so publishing a new version (new id) makes every prior acceptance stop
 * matching, forcing re-consent with no per-user bookkeeping.
 *
 * `ConsentDocument` is NOT a tenant model — its reads run unscoped naturally.
 * `ConsentRecord` IS a tenant model, but this service keys every query on an
 * EXPLICIT `userId` (the guard checks the request user; the TDA-011 fan-out
 * checks arbitrary users), so all `ConsentRecord` access runs inside
 * {@link TenantContextService.runWithoutTenant} — mirroring TDA-007's
 * `SubscriptionService`.
 */
@Injectable()
export class ConsentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly audits: AuditService,
  ) {}

  /**
   * The ONLY content-hash implementation (spec §3). Reuses TDA-008's single
   * canonicalizer + hasher so the digest is identical on publish, on
   * accept-time verification, and in any later audit. Never hash a disclosure
   * body anywhere else (especially not in SQL).
   */
  computeContentHash(kind: string, version: string, body: string): string {
    return 'sha256:' + sha256(canonicalize({ kind, version, body }));
  }

  /**
   * The single `active` document for `kind`, or `null` if none is published.
   * `ConsentDocument` is global (not tenant-scoped), so this reads unscoped.
   */
  async getCurrent(
    kind: string = RISK_DISCLOSURE,
  ): Promise<CurrentConsent | null> {
    const doc = await this.prisma.consentDocument.findFirst({
      where: { kind, active: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!doc) return null;
    return {
      documentId: doc.id,
      kind: doc.kind,
      version: doc.version,
      body: doc.body,
      contentHash: doc.contentHash,
      createdAt: doc.createdAt,
    };
  }
}
