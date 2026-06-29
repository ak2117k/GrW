import {
  Injectable,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { SYSTEM_USER_ID } from '../../../common/tenant/tenant.constants';
import { UpdateSettingsDto } from '../dto/settings.dto';
import { UserSettings } from '@prisma/client';
import {
  DEFAULT_MAX_CAPITAL_PER_TRADE,
  DEFAULT_MAX_CONCURRENT_POSITIONS,
} from '@td/shared';

const DEFAULT_SETTINGS = {
  paperTrading: true,
  maxDailyLoss: 5000,
  maxCapitalPerTrade: DEFAULT_MAX_CAPITAL_PER_TRADE,
  maxConcurrentPositions: DEFAULT_MAX_CONCURRENT_POSITIONS,
  defaultRiskReward: 2.0,
  autoTradeMode: 'OFF',
  activeStrategies: ['rsi-reversal', 'ema-crossover', 'vwap-deviation'],
  preferredSegments: ['OPTIONS', 'EQUITY'],
  tradingHoursOnly: true,
  notificationsEnabled: true,
};

/** Known valid strategy names that exist in the strategy registry. */
const VALID_STRATEGY_NAMES = ['rsi-reversal', 'ema-crossover', 'vwap-deviation'];

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getSettings(): Promise<UserSettings> {
    let settings = await this.prisma.userSettings.findFirst();

    if (!settings) {
      this.logger.log('No settings found, creating defaults');
      // Default ("global") settings row — UserSettings.userId is `@unique`, and
      // ADMIN's row is the de-facto global one until per-user settings land.
      // Stamp the ADMIN owner so the NOT NULL userId column (TDA-001) is met.
      settings = await this.prisma.userSettings.create({
        data: { ...DEFAULT_SETTINGS, userId: SYSTEM_USER_ID },
      });
    }

    // Sanitize activeStrategies: if the DB has strategy names not in the
    // registry (e.g. stale "gamma-blast"), replace with defaults.
    const activeStrategies: string[] = settings.activeStrategies ?? [];
    const validActive = activeStrategies.filter((name) =>
      VALID_STRATEGY_NAMES.includes(name),
    );

    if (validActive.length !== activeStrategies.length) {
      const invalid = activeStrategies.filter(
        (name) => !VALID_STRATEGY_NAMES.includes(name),
      );
      this.logger.warn(
        `activeStrategies contains unknown strategies [${invalid.join(', ')}] — replacing with defaults`,
      );

      settings = await this.prisma.userSettings.update({
        where: { id: settings.id },
        data: {
          activeStrategies: DEFAULT_SETTINGS.activeStrategies,
        },
      });
    }

    return settings;
  }

  async updateSettings(dto: UpdateSettingsDto): Promise<UserSettings> {
    const existing = await this.getSettings();

    // Build update data from non-undefined fields
    const updateData: Record<string, any> = {};

    if (dto.autoTradeMode !== undefined) updateData.autoTradeMode = dto.autoTradeMode;
    if (dto.paperTrading !== undefined) updateData.paperTrading = dto.paperTrading;
    if (dto.maxDailyLoss !== undefined) updateData.maxDailyLoss = dto.maxDailyLoss;
    if (dto.maxCapitalPerTrade !== undefined) updateData.maxCapitalPerTrade = dto.maxCapitalPerTrade;
    if (dto.maxConcurrentPositions !== undefined) updateData.maxConcurrentPositions = dto.maxConcurrentPositions;
    if (dto.defaultRiskReward !== undefined) updateData.defaultRiskReward = dto.defaultRiskReward;
    if (dto.activeStrategies !== undefined) updateData.activeStrategies = dto.activeStrategies;
    if (dto.preferredSegments !== undefined) updateData.preferredSegments = dto.preferredSegments;
    if (dto.tradingHoursOnly !== undefined) updateData.tradingHoursOnly = dto.tradingHoursOnly;
    if (dto.notificationsEnabled !== undefined) updateData.notificationsEnabled = dto.notificationsEnabled;

    if (Object.keys(updateData).length === 0) {
      throw new HttpException('No fields to update', HttpStatus.BAD_REQUEST);
    }

    this.logger.log(`Updating settings: ${JSON.stringify(Object.keys(updateData))}`);

    return this.prisma.userSettings.update({
      where: { id: existing.id },
      data: updateData,
    });
  }

  async resetSettings(): Promise<UserSettings> {
    // Delete all existing settings
    await this.prisma.userSettings.deleteMany();

    this.logger.log('Settings reset to defaults');

    return this.prisma.userSettings.create({
      data: { ...DEFAULT_SETTINGS, userId: SYSTEM_USER_ID },
    });
  }

  async activateKillSwitch(): Promise<UserSettings> {
    const existing = await this.getSettings();

    this.logger.warn('KILL SWITCH ACTIVATED — setting autoTradeMode to OFF');

    const updated = await this.prisma.userSettings.update({
      where: { id: existing.id },
      data: { autoTradeMode: 'OFF' },
    });

    this.logger.warn(
      `Kill switch executed at ${new Date().toISOString()}. All auto-trading disabled.`,
    );

    return updated;
  }
}
