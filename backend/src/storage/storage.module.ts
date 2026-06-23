import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';

/** Global so the invoices, processing, and export code can all inject it. */
@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
