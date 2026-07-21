import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';

export class TelegramChannelDto {
  @IsString() @IsNotEmpty() tgChannelId!: string;
  @IsOptional() @IsString() username?: string | null;
  @IsString() @IsNotEmpty() title!: string;
}

export class TelegramMessageDto {
  @IsInt() tgMessageId!: number;
  @IsString() rawText!: string;
  @IsString() @IsNotEmpty() postedAt!: string; // ISO
}

export class TelegramIngestDto {
  @ValidateNested() @Type(() => TelegramChannelDto) channel!: TelegramChannelDto;
  @ValidateNested() @Type(() => TelegramMessageDto) message!: TelegramMessageDto;
  @IsObject() parsed!: Record<string, unknown>;
}
