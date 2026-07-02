import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { AuditService } from '../../common/audit/audit.service';
import { canonicalize, sha256 } from '../../common/audit/canonicalize';
import { CONSENT_ERRORS, RISK_DISCLOSURE } from './consent.constants';

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

  /**
   * The caller's consent status against the current active document (spec §4).
   * `accepted` iff a `ConsentRecord` exists for the active doc id;
   * `requiresReconsent` iff the user accepted an OLDER version but not the
   * current one. Fail-closed: no active doc → currentVersion null, not accepted.
   */
  async getStatus(
    userId: string,
    kind: string = RISK_DISCLOSURE,
  ): Promise<ConsentStatus> {
    const current = await this.getCurrent(kind);

    return this.tenant.runWithoutTenant(async () => {
      // The user's most-recent acceptance for THIS kind (any version).
      const latest = await this.prisma.consentRecord.findFirst({
        where: { userId, document: { kind } },
        orderBy: { acceptedAt: 'desc' },
        select: { version: true, documentId: true },
      });
      const acceptedVersion = latest?.version ?? null;

      if (!current) {
        return {
          currentVersion: null,
          accepted: false,
          acceptedVersion,
          requiresReconsent: false,
        };
      }

      const accepted = latest?.documentId === current.documentId;
      return {
        currentVersion: current.version,
        accepted,
        acceptedVersion,
        // Accepted some prior version but not the current active document.
        requiresReconsent: !accepted && acceptedVersion !== null,
      };
    });
  }

  /**
   * The TDA-011 seam. `true` iff a `ConsentRecord` exists for `userId` and the
   * CURRENT active document. Worker-safe (explicit userId, no request context)
   * and fail-closed: no active doc → `false` (no disclosure ⇒ no execution).
   */
  hasAcceptedCurrent(
    userId: string,
    kind: string = RISK_DISCLOSURE,
  ): Promise<boolean> {
    return this.tenant.runWithoutTenant(async () => {
      const current = await this.getCurrent(kind);
      if (!current) return false;
      const row = await this.prisma.consentRecord.findFirst({
        where: { userId, documentId: current.documentId },
        select: { id: true },
      });
      return !!row;
    });
  }

  /**
   * Record a user's acceptance of the current disclosure (spec §4.1).
   *
   * Guards: no active doc → 409 NO_ACTIVE_CONSENT; version ≠ active → 409
   * CONSENT_VERSION_STALE; recomputed hash ≠ stored OR ≠ echoed → 409
   * CONSENT_CONTENT_MISMATCH. Then an idempotent upsert on
   * `(userId, documentId)`, then a FATAL `CONSENT_ACCEPT` audit append (let it
   * throw — safe because the upsert is idempotent on retry). IP/user-agent are
   * captured server-side by the controller and stored + echoed into the audit.
   */
  async accept(
    userId: string,
    version: string,
    contentHash: string,
    ip: string | null,
    userAgent: string | null,
  ): Promise<ConsentStatus> {
    const current = await this.getCurrent();
    if (!current) {
      throw new ConflictException({ code: CONSENT_ERRORS.NO_ACTIVE_CONSENT });
    }
    if (version !== current.version) {
      throw new ConflictException({
        code: CONSENT_ERRORS.CONSENT_VERSION_STALE,
        currentVersion: current.version,
      });
    }
    const recomputed = this.computeContentHash(
      current.kind,
      current.version,
      current.body,
    );
    if (recomputed !== current.contentHash || recomputed !== contentHash) {
      throw new ConflictException({
        code: CONSENT_ERRORS.CONSENT_CONTENT_MISMATCH,
      });
    }

    await this.tenant.runWithoutTenant(() =>
      this.prisma.consentRecord.upsert({
        where: {
          userId_documentId: { userId, documentId: current.documentId },
        },
        update: { version, ipAddress: ip, userAgent, acceptedAt: new Date() },
        create: {
          userId,
          documentId: current.documentId,
          version,
          ipAddress: ip,
          userAgent,
        },
      }),
    );

    // FATAL audit (spec §4.1): if append throws, accept throws.
    await this.audits.append({
      action: 'CONSENT_ACCEPT',
      userId,
      target: version,
      meta: { documentId: current.documentId, contentHash, kind: current.kind, ip, userAgent },
    });

    return this.getStatus(userId, current.kind);
  }

  /**
   * Withdraw the caller's consent for the current active document (spec §7):
   * delete the acceptance row so `hasAcceptedCurrent` closes, then a FATAL
   * `CONSENT_REVOKE` audit append. Historical `CONSENT_ACCEPT` rows are
   * permanent evidence and are NOT deleted (§10.4).
   */
  async revoke(userId: string, kind: string = RISK_DISCLOSURE): Promise<void> {
    const current = await this.getCurrent(kind);
    if (!current) {
      throw new ConflictException({ code: CONSENT_ERRORS.NO_ACTIVE_CONSENT });
    }

    await this.tenant.runWithoutTenant(() =>
      this.prisma.consentRecord.deleteMany({
        where: { userId, documentId: current.documentId },
      }),
    );

    await this.audits.append({
      action: 'CONSENT_REVOKE',
      userId,
      target: current.version,
      meta: { documentId: current.documentId, kind: current.kind },
    });
  }

  /**
   * Publish a new disclosure version (ADMIN). In one transaction, deactivate the
   * current active doc of `kind` and create the new active one (unique `version`
   * guards accidental re-publish); the new id makes every prior acceptance stop
   * matching, forcing global re-consent. Then a FATAL
   * `CONSENT_VERSION_PUBLISHED` audit append (let it throw).
   */
  async publish(
    kind: string,
    version: string,
    body: string,
    actorUserId: string | null,
  ): Promise<CurrentConsent> {
    const contentHash = this.computeContentHash(kind, version, body);

    const { doc, previousVersion } = await this.prisma.$transaction(
      async (tx) => {
        const prev = await tx.consentDocument.findFirst({
          where: { kind, active: true },
          orderBy: { createdAt: 'desc' },
          select: { version: true },
        });
        await tx.consentDocument.updateMany({
          where: { kind, active: true },
          data: { active: false },
        });
        const created = await tx.consentDocument.create({
          data: { kind, version, body, contentHash, active: true },
        });
        return { doc: created, previousVersion: prev?.version ?? null };
      },
    );

    // FATAL audit (spec §4.1 / §6): publishing is the only path that mints a
    // new current version and forces global re-consent — record it.
    await this.audits.append({
      action: 'CONSENT_VERSION_PUBLISHED',
      userId: actorUserId,
      target: version,
      meta: { kind, contentHash, previousVersion },
    });

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
