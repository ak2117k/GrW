import { IsString, MinLength } from 'class-validator';

export class CloseWatchDto {
  @IsString()
  @MinLength(1)
  reason!: string;
}
