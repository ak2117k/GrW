import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

/** Content-hash shape: the self-describing 'sha256:<64hex>' form (spec §3). */
const CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * `POST /api/consent/accept` body. The client echoes the `version` +
 * `contentHash` it was shown; IP + user-agent are captured server-side and are
 * NEVER read from the body (spec §7).
 */
export class AcceptConsentDto {
  @IsString()
  @IsNotEmpty()
  version!: string;

  @Matches(CONTENT_HASH_RE, {
    message: 'contentHash must be of the form sha256:<64 hex chars>',
  })
  contentHash!: string;
}

/**
 * `POST /api/admin/consent/publish` body. `kind` defaults to the risk
 * disclosure when omitted; `version` must be unique (guards accidental
 * re-publish); `body` is the full disclosure text.
 */
export class PublishConsentDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  kind?: string;

  @IsString()
  @IsNotEmpty()
  version!: string;

  @IsString()
  @IsNotEmpty()
  body!: string;
}
