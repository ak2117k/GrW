import { IsString, IsNotEmpty, IsObject } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RequestInsightDto {
  @ApiProperty({ description: 'Section identifier', example: 'market-breadth' })
  @IsString()
  @IsNotEmpty()
  sectionKey!: string;

  @ApiProperty({ description: 'Context key within section', example: 'default' })
  @IsString()
  @IsNotEmpty()
  contextKey!: string;

  @ApiProperty({ description: 'Snapshot of input data for analysis' })
  @IsObject()
  contextData!: Record<string, unknown>;
}
