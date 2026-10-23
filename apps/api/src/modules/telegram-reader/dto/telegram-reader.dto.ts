import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class StartTelegramLoginDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  apiId!: number;

  @IsString()
  @Matches(/^[a-f0-9]{32}$/i, { message: 'api_hash is the 32-character hex string from my.telegram.org' })
  apiHash!: string;

  @IsString()
  @Matches(/^\+?[\d\s-]{7,20}$/, { message: 'phone must be in international format, e.g. +91…' })
  phone!: string;
}

export class ConfirmTelegramLoginDto {
  @IsOptional()
  @IsString()
  @MaxLength(12)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  password?: string;
}

export class SetTelegramChannelsDto {
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  tgChannelIds!: string[];
}
