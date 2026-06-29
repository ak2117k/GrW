import {
  Injectable,
  Logger,
  NotFoundException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { SYSTEM_USER_ID } from '../../../common/tenant/tenant.constants';
import {
  CreateAlertDto,
  UpdateAlertDto,
  AlertFilterDto,
} from '../dto/alerts.dto';
import { Alert } from '@prisma/client';
import { TickData } from '../../../common/interfaces/broker-adapter.interface';

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getAlerts(filters: AlertFilterDto): Promise<Alert[]> {
    const where: Record<string, any> = {};

    if (filters.isActive !== undefined) {
      where.isActive = filters.isActive;
    }

    if (filters.type) {
      where.type = filters.type;
    }

    return this.prisma.alert.findMany({
      where,
      include: { instrument: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createAlert(dto: CreateAlertDto): Promise<Alert> {
    // If instrumentId provided, verify it exists
    if (dto.instrumentId) {
      const instrument = await this.prisma.instrument.findUnique({
        where: { id: dto.instrumentId },
      });
      if (!instrument) {
        throw new NotFoundException(
          `Instrument with id "${dto.instrumentId}" not found`,
        );
      }
    }

    this.logger.log(`Creating alert: type=${dto.type}, condition=${dto.condition}`);

    return this.prisma.alert.create({
      data: {
        // Created outside an authenticated tenant context → stamp the ADMIN
        // owner so the NOT NULL userId column (TDA-001) is satisfied.
        userId: SYSTEM_USER_ID,
        type: dto.type,
        condition: dto.condition,
        value: dto.value,
        message: dto.message,
        instrumentId: dto.instrumentId || null,
      },
      include: { instrument: true },
    });
  }

  async updateAlert(id: string, dto: UpdateAlertDto): Promise<Alert> {
    const existing = await this.prisma.alert.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Alert with id "${id}" not found`);
    }

    const updateData: Record<string, any> = {};

    if (dto.type !== undefined) updateData.type = dto.type;
    if (dto.condition !== undefined) updateData.condition = dto.condition;
    if (dto.value !== undefined) updateData.value = dto.value;
    if (dto.message !== undefined) updateData.message = dto.message;
    if (dto.instrumentId !== undefined) updateData.instrumentId = dto.instrumentId;
    if (dto.isActive !== undefined) updateData.isActive = dto.isActive;

    if (Object.keys(updateData).length === 0) {
      throw new HttpException('No fields to update', HttpStatus.BAD_REQUEST);
    }

    this.logger.log(`Updating alert ${id}: ${JSON.stringify(Object.keys(updateData))}`);

    return this.prisma.alert.update({
      where: { id },
      data: updateData,
      include: { instrument: true },
    });
  }

  async deleteAlert(id: string): Promise<{ deleted: boolean }> {
    const existing = await this.prisma.alert.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Alert with id "${id}" not found`);
    }

    await this.prisma.alert.delete({ where: { id } });

    this.logger.log(`Deleted alert ${id}`);

    return { deleted: true };
  }

  async acknowledgeAlert(id: string): Promise<Alert> {
    const existing = await this.prisma.alert.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Alert with id "${id}" not found`);
    }

    this.logger.log(`Acknowledging alert ${id}`);

    return this.prisma.alert.update({
      where: { id },
      data: { triggeredAt: null },
      include: { instrument: true },
    });
  }

  /**
   * Evaluate all active alerts against current market data.
   * Called by MarketFeedService on each tick.
   */
  async checkAlerts(currentData: TickData): Promise<Alert[]> {
    const activeAlerts = await this.prisma.alert.findMany({
      where: {
        isActive: true,
        triggeredAt: null,
      },
      include: { instrument: true },
    });

    const triggeredAlerts: Alert[] = [];

    for (const alert of activeAlerts) {
      // Only check alerts relevant to this instrument
      if (alert.instrumentId && alert.instrument) {
        if (alert.instrument.token !== currentData.token) {
          continue;
        }
      }

      let triggered = false;

      switch (alert.type) {
        case 'price':
          if (alert.value !== null) {
            if (alert.condition === 'above' && currentData.ltp >= alert.value) {
              triggered = true;
            } else if (alert.condition === 'below' && currentData.ltp <= alert.value) {
              triggered = true;
            }
          }
          break;

        case 'oi_spike':
          if (
            alert.value !== null &&
            currentData.oi !== undefined &&
            alert.condition === 'spike'
          ) {
            // Trigger if OI exceeds threshold value
            if (currentData.oi >= alert.value) {
              triggered = true;
            }
          }
          break;

        // pnl and news alerts are evaluated elsewhere
        default:
          break;
      }

      if (triggered) {
        const updated = await this.prisma.alert.update({
          where: { id: alert.id },
          data: { triggeredAt: new Date() },
          include: { instrument: true },
        });
        triggeredAlerts.push(updated);
        this.logger.warn(
          `Alert triggered: [${alert.type}] ${alert.condition} ${alert.value} for ${currentData.symbol}`,
        );
      }
    }

    return triggeredAlerts;
  }
}
