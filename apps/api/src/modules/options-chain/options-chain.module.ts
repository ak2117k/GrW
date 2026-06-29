import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { OptionsChainController } from './controllers/options-chain.controller';
import { OptionsChainService } from './services/options-chain.service';
import { GreeksCalculatorService } from './services/greeks-calculator.service';
import { NseOptionsChainService } from './services/nse-options-chain.service';
import { OptionStrikeSelectorService } from './services/option-strike-selector.service';

@Module({
  imports: [PrismaModule, forwardRef(() => MarketDataModule)],
  controllers: [OptionsChainController],
  providers: [
    OptionsChainService,
    GreeksCalculatorService,
    NseOptionsChainService,
    OptionStrikeSelectorService,
    // BROKER_ADAPTER_TOKEN is exported by MarketDataModule and available
    // via injection — no need to re-provide it here.
  ],
  exports: [OptionsChainService, GreeksCalculatorService, OptionStrikeSelectorService],
})
export class OptionsChainModule {}
