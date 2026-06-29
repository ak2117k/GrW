import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AngelOneAuthService } from '../../market-data/services/angel-one-auth.service';
import { SaveBrokerCredentialsDto } from '../dto/broker.dto';

@Injectable()
export class BrokerService implements OnModuleInit {
  private readonly logger = new Logger(BrokerService.name);

  private static readonly ENCRYPTION_KEY = crypto
    .createHash('sha256')
    .update(process.env.ENCRYPTION_KEY || 'td-automation-default-key-change-me')
    .digest();

  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AngelOneAuthService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const creds = await this.prisma.brokerCredential.findFirst({
        where: { broker: 'angel_one', isActive: true },
      });

      if (creds) {
        this.logger.log('Found saved broker credentials, auto-connecting...');
        await this.connect();
      }
    } catch (error) {
      this.logger.warn(
        `Auto-connect on startup failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  async saveCredentials(dto: SaveBrokerCredentialsDto) {
    const encryptedPassword = BrokerService.encrypt(
      dto.password,
      BrokerService.ENCRYPTION_KEY,
    );
    const encryptedTotp = BrokerService.encrypt(
      dto.totpSecret,
      BrokerService.ENCRYPTION_KEY,
    );

    const saved = await this.prisma.brokerCredential.upsert({
      where: { broker: 'angel_one' },
      update: {
        apiKey: dto.apiKey,
        clientId: dto.clientId,
        password: encryptedPassword,
        totpSecret: encryptedTotp,
        isActive: true,
      },
      create: {
        broker: 'angel_one',
        apiKey: dto.apiKey,
        clientId: dto.clientId,
        password: encryptedPassword,
        totpSecret: encryptedTotp,
        isActive: true,
      },
    });

    // Update in-memory credentials with plaintext values
    this.authService.updateCredentials(
      dto.apiKey,
      dto.clientId,
      dto.password,
      dto.totpSecret,
    );

    return {
      success: true,
      message: 'Broker credentials saved successfully',
      clientId: saved.clientId,
    };
  }

  async connect() {
    const creds = await this.prisma.brokerCredential.findFirst({
      where: { broker: 'angel_one', isActive: true },
    });

    if (!creds) {
      return { success: false, message: 'No saved credentials found' };
    }

    try {
      const password = BrokerService.decrypt(
        creds.password,
        BrokerService.ENCRYPTION_KEY,
      );
      const totpSecret = BrokerService.decrypt(
        creds.totpSecret,
        BrokerService.ENCRYPTION_KEY,
      );

      this.authService.updateCredentials(
        creds.apiKey,
        creds.clientId,
        password,
        totpSecret,
      );

      await this.authService.login();

      await this.prisma.brokerCredential.update({
        where: { broker: 'angel_one' },
        data: { lastConnected: new Date() },
      });

      return { success: true, message: 'Connected to Angel One successfully' };
    } catch (error) {
      return {
        success: false,
        message: `Connection failed: ${error instanceof Error ? error.message : error}`,
      };
    }
  }

  async disconnect() {
    try {
      await this.authService.logout();
      return { success: true, message: 'Disconnected from Angel One' };
    } catch (error) {
      return {
        success: false,
        message: `Disconnect failed: ${error instanceof Error ? error.message : error}`,
      };
    }
  }

  async getStatus() {
    const creds = await this.prisma.brokerCredential.findFirst({
      where: { broker: 'angel_one' },
    });

    return {
      connected: this.authService.isAuthenticated(),
      clientId: this.authService.getClientId() || null,
      lastConnected: creds?.lastConnected || null,
    };
  }

  async getAccountInfo() {
    if (!this.authService.isAuthenticated()) {
      return { success: false, message: 'Not connected to broker' };
    }

    try {
      const [profile, rms, orderBook] = await Promise.all([
        this.authService.getProfile(),
        this.authService.getRMS(),
        this.authService.getOrderBook(),
      ]);

      return {
        success: true,
        profile: profile?.data || profile,
        rms: rms?.data || rms,
        orderBook: orderBook?.data || orderBook,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to fetch account info: ${error instanceof Error ? error.message : error}`,
      };
    }
  }

  async getSavedCredentials() {
    const creds = await this.prisma.brokerCredential.findFirst({
      where: { broker: 'angel_one' },
    });

    if (!creds) {
      return { saved: false };
    }

    return {
      saved: true,
      apiKey: creds.apiKey,
      clientId: creds.clientId,
      isActive: creds.isActive,
      lastConnected: creds.lastConnected,
    };
  }

  private static encrypt(text: string, key: Buffer): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([
      cipher.update(text, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  private static decrypt(encryptedText: string, key: Buffer): string {
    const [ivHex, authTagHex, dataHex] = encryptedText.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encrypted = Buffer.from(dataHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(encrypted) + decipher.final('utf8');
  }
}
