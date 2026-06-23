import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventsModule } from '../events/events.module';
import { INVOICE_QUEUE } from '../processing/processing.constants';
import { Invoice } from './entities/invoice.entity';
import { ExportService } from './export.service';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Invoice]),
    BullModule.registerQueue({ name: INVOICE_QUEUE }),
    EventsModule,
  ],
  controllers: [InvoicesController],
  providers: [InvoicesService, ExportService],
  exports: [InvoicesService],
})
export class InvoicesModule {}
