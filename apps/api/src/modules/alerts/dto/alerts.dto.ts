import {
  IsOptional,
  IsBoolean,
  IsNumber,
  IsString,
  IsEnum,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export enum AlertType {
  PRICE = 'price',
  OI_SPIKE = 'oi_spike',
  NEWS = 'news',
  PNL = 'pnl',
}

export enum AlertCondition {
  ABOVE = 'above',
  BELOW = 'below',
  SPIKE = 'spike',
  THRESHOLD = 'threshold',
}

export class CreateAlertDto {
  @ApiProperty({ enum: AlertType })
  @IsEnum(AlertType, {
    message: 'type must be one of: price, oi_spike, news, pnl',
  })
  type: AlertType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  instrumentId?: string;

  @ApiProperty({ enum: AlertCondition })
  @IsEnum(AlertCondition, {
    message: 'condition must be one of: above, below, spike, threshold',
  })
  condition: AlertCondition;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  value?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  message?: string;
}

export class UpdateAlertDto {
  @ApiPropertyOptional({ enum: AlertType })
  @IsOptional()
  @IsEnum(AlertType, {
    message: 'type must be one of: price, oi_spike, news, pnl',
  })
  type?: AlertType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  instrumentId?: string;

  @ApiPropertyOptional({ enum: AlertCondition })
  @IsOptional()
  @IsEnum(AlertCondition, {
    message: 'condition must be one of: above, below, spike, threshold',
  })
  condition?: AlertCondition;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  value?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  message?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class AlertFilterDto {
  @ApiPropertyOptional({ description: 'Filter by active status' })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ enum: AlertType, description: 'Filter by alert type' })
  @IsOptional()
  @IsEnum(AlertType, {
    message: 'type must be one of: price, oi_spike, news, pnl',
  })
  type?: AlertType;
}
