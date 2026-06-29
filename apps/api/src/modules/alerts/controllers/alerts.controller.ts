import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { AlertsService } from '../services/alerts.service';
import {
  CreateAlertDto,
  UpdateAlertDto,
  AlertFilterDto,
} from '../dto/alerts.dto';

@ApiTags('Alerts')
@Controller('api/alerts')
export class AlertsController {
  constructor(private readonly alertsService: AlertsService) {}

  @Get()
  @ApiOperation({ summary: 'List all alerts with optional filters' })
  @ApiResponse({ status: 200, description: 'List of alerts' })
  async getAlerts(@Query() filters: AlertFilterDto) {
    return this.alertsService.getAlerts(filters);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new alert' })
  @ApiResponse({ status: 201, description: 'Alert created' })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  async createAlert(@Body() dto: CreateAlertDto) {
    return this.alertsService.createAlert(dto);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update an existing alert' })
  @ApiParam({ name: 'id', description: 'Alert ID' })
  @ApiResponse({ status: 200, description: 'Alert updated' })
  @ApiResponse({ status: 404, description: 'Alert not found' })
  async updateAlert(@Param('id') id: string, @Body() dto: UpdateAlertDto) {
    return this.alertsService.updateAlert(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an alert' })
  @ApiParam({ name: 'id', description: 'Alert ID' })
  @ApiResponse({ status: 200, description: 'Alert deleted' })
  @ApiResponse({ status: 404, description: 'Alert not found' })
  async deleteAlert(@Param('id') id: string) {
    return this.alertsService.deleteAlert(id);
  }

  @Post(':id/acknowledge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Acknowledge a triggered alert' })
  @ApiParam({ name: 'id', description: 'Alert ID' })
  @ApiResponse({ status: 200, description: 'Alert acknowledged' })
  @ApiResponse({ status: 404, description: 'Alert not found' })
  async acknowledgeAlert(@Param('id') id: string) {
    return this.alertsService.acknowledgeAlert(id);
  }
}
