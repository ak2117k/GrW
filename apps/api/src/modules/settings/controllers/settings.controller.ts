import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { SettingsService } from '../services/settings.service';
import { UpdateSettingsDto } from '../dto/settings.dto';

@ApiTags('Settings')
@Controller('api/settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Get current trading settings' })
  @ApiResponse({ status: 200, description: 'Current settings returned' })
  async getSettings() {
    return this.settingsService.getSettings();
  }

  @Put()
  @ApiOperation({ summary: 'Update trading settings (partial update)' })
  @ApiResponse({ status: 200, description: 'Settings updated' })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  async updateSettings(@Body() dto: UpdateSettingsDto) {
    return this.settingsService.updateSettings(dto);
  }

  @Post('reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset settings to defaults' })
  @ApiResponse({ status: 200, description: 'Settings reset to defaults' })
  async resetSettings() {
    return this.settingsService.resetSettings();
  }

  @Get('kill-switch')
  @ApiOperation({ summary: 'Activate kill switch — disable all auto-trading' })
  @ApiResponse({ status: 200, description: 'Kill switch activated' })
  async activateKillSwitch() {
    const settings = await this.settingsService.activateKillSwitch();
    return {
      message: 'Kill switch activated. All auto-trading has been disabled.',
      settings,
    };
  }
}
