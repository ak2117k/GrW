import { IsString, IsNotEmpty } from 'class-validator';

export class SaveBrokerCredentialsDto {
  @IsString()
  @IsNotEmpty()
  apiKey: string;

  @IsString()
  @IsNotEmpty()
  clientId: string;

  @IsString()
  @IsNotEmpty()
  password: string;

  @IsString()
  @IsNotEmpty()
  totpSecret: string;
}
