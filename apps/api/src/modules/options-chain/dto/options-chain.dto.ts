import { IsString, IsOptional, IsNumberString } from 'class-validator';

export class GetChainDto {
  @IsString()
  @IsOptional()
  expiry?: string;
}

export class GreeksQueryDto {
  @IsNumberString()
  spot: string;

  @IsNumberString()
  strike: string;

  @IsString()
  expiry: string;

  @IsNumberString()
  iv: string;

  @IsString()
  type: 'CE' | 'PE';
}
