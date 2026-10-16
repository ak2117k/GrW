import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { NewsEventsCoreModule } from '../news-events-core.module';
import { NewsIndexService } from './news-index.service';

@Module({ imports: [NewsEventsCoreModule, PrismaModule], providers: [NewsIndexService], exports: [NewsIndexService] })
export class NewsIndexModule {}
