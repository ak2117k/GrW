import { Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { BreakoutSwingRepository } from '../repositories/breakout-swing.repository';

@Controller('api/breakout-swing')
export class BreakoutSwingController {
  constructor(private readonly repo: BreakoutSwingRepository) {}

  @Get('entries')
  async listEntries(@Query('from') from?: string) {
    return this.repo.listEntries({ from: from ? new Date(from) : undefined });
  }

  @Get('capital')
  async getCapital() {
    return this.repo.getCapital();
  }

  /** Cancel a still-resting QUEUED entry (QUEUED → DISMISSED). */
  @Post(':id/cancel')
  async cancel(@Param('id') id: string) {
    const queued = await this.repo.listQueued();
    const target = queued.find((e) => e.id === id);
    if (!target) throw new NotFoundException(`No QUEUED breakout-swing entry ${id}`);
    await this.repo.updateStatus(id, { status: 'DISMISSED', exitedAt: new Date(), exitReason: 'cancelled' });
    return { id, status: 'DISMISSED' };
  }
}
