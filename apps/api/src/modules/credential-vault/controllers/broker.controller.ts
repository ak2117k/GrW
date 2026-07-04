import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../../../common/decorators';
import { ConnectAngelOneDto } from '../dto/connect-angel-one.dto';
import {
  BrokerStatus,
  ConnectResult,
  CredentialVaultService,
} from '../services/credential-vault.service';
import {
  BrokerOverview,
  BrokerOverviewService,
} from '../services/broker-overview.service';

/**
 * Per-user broker credential surface (TDA-005 §5.1), rebuilt on the vault.
 * All routes are authenticated (global JwtAuthGuard) and scoped to the caller
 * via `@CurrentUser('userId')`; BrokerCredential is tenant-scoped by TDA-003.
 *
 *   POST   /api/broker/connect   validate + envelope-encrypt + upsert (422 on failure)
 *   GET    /api/broker/status    non-secret metadata (no KMS calls)
 *   GET    /api/broker/overview  ONE ephemeral login → sanitized funds+profile+positions (404 if not connected)
 *   DELETE /api/broker           delete row + CREDENTIAL_DELETE (204)
 */
@Controller('api/broker')
export class BrokerController {
  constructor(
    private readonly vault: CredentialVaultService,
    private readonly overview: BrokerOverviewService,
  ) {}

  @Post('connect')
  @HttpCode(HttpStatus.OK)
  connect(
    @CurrentUser('userId') userId: string,
    @Body() dto: ConnectAngelOneDto,
    @Ip() ip: string,
  ): Promise<ConnectResult> {
    return this.vault.connect(userId, dto, { ip });
  }

  @Get('status')
  getStatus(@CurrentUser('userId') userId: string): Promise<BrokerStatus> {
    return this.vault.getStatus(userId);
  }

  /**
   * Live, read-only account overview for the caller. Performs ONE ephemeral
   * Angel One login and returns a sanitized funds+profile+positions payload
   * (no tokens/creds/raw envelope). 404 when no account is connected.
   */
  @Get('overview')
  getOverview(@CurrentUser('userId') userId: string): Promise<BrokerOverview> {
    return this.overview.getOverview(userId);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  disconnect(@CurrentUser('userId') userId: string, @Ip() ip: string): Promise<void> {
    return this.vault.disconnect(userId, { ip });
  }
}
