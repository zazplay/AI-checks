import { Injectable, Logger } from '@nestjs/common';
import { ZipArchive } from 'archiver';
import * as ExcelJS from 'exceljs';
import { PassThrough, Readable } from 'stream';
import { Invoice } from './entities/invoice.entity';
import { StorageService } from '../storage/storage.service';

/** Columns shared by the spreadsheet exports (xlsx + csv). */
const COLUMNS: Array<{ header: string; pick: (i: Invoice) => string | number }> = [
  { header: 'File', pick: (i) => i.originalFilename },
  { header: 'Status', pick: (i) => i.status },
  { header: 'Vendor', pick: (i) => i.extractedData?.vendorName ?? '' },
  { header: 'Invoice #', pick: (i) => i.extractedData?.invoiceNumber ?? '' },
  { header: 'Invoice date', pick: (i) => i.extractedData?.invoiceDate ?? '' },
  { header: 'Due date', pick: (i) => i.extractedData?.dueDate ?? '' },
  { header: 'Currency', pick: (i) => i.extractedData?.currency ?? '' },
  { header: 'Subtotal', pick: (i) => i.extractedData?.subtotal ?? '' },
  { header: 'Tax', pick: (i) => i.extractedData?.tax ?? '' },
  { header: 'Total', pick: (i) => i.extractedData?.total ?? '' },
  { header: 'Line items', pick: (i) => i.extractedData?.lineItems?.length ?? 0 },
  { header: 'Uploaded at', pick: (i) => i.createdAt.toISOString() },
];

/**
 * Builds export artefacts from a set of invoices: an Excel workbook, a CSV, and
 * a ZIP archive of the original uploaded files. Each returns a Readable stream
 * so the controller can pipe it straight to the HTTP response.
 */
@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);

  constructor(private readonly storage: StorageService) {}

  /** Excel (.xlsx) with one row per invoice. */
  async toXlsx(invoices: Invoice[]): Promise<Readable> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Invoice Processing System';
    const ws = wb.addWorksheet('Invoices');

    ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.header, width: 18 }));
    ws.getRow(1).font = { bold: true };
    for (const inv of invoices) {
      ws.addRow(COLUMNS.map((c) => c.pick(inv)));
    }

    // Write to a buffer, then hand back a stream (exceljs streaming writer is
    // heavier; invoice counts here are small enough that a buffer is simplest).
    const buffer = await wb.xlsx.writeBuffer();
    return Readable.from(Buffer.from(buffer as ArrayBuffer));
  }

  /** Plain CSV with the same columns (no dependency, opens in Excel). */
  toCsv(invoices: Invoice[]): Readable {
    const esc = (v: string | number): string => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      COLUMNS.map((c) => esc(c.header)).join(','),
      ...invoices.map((inv) => COLUMNS.map((c) => esc(c.pick(inv))).join(',')),
    ];
    // Prepend a BOM so Excel detects UTF-8 (vendor names with accents, etc).
    return Readable.from('﻿' + lines.join('\r\n'));
  }

  /**
   * ZIP archive of the original uploaded files. Filenames are prefixed with an
   * index to avoid collisions when two invoices share an original name. Missing
   * files on disk are skipped (logged), so a partial archive still streams.
   */
  async toZip(invoices: Invoice[]): Promise<Readable> {
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const out = new PassThrough();
    archive.on('warning', (err: Error) => this.logger.warn(`Archive warning: ${String(err)}`));
    archive.on('error', (err: Error) => {
      this.logger.error(`Archive error: ${String(err)}`);
      out.destroy(err);
    });
    archive.pipe(out);

    // Append each stored file (disk or S3) as a stream. Done sequentially so a
    // missing/unreadable file is skipped without aborting the whole archive.
    let added = 0;
    for (let idx = 0; idx < invoices.length; idx++) {
      const inv = invoices[idx];
      try {
        if (!(await this.storage.exists(inv.storedPath))) {
          this.logger.warn(`Skipping missing file for invoice ${inv.id}: ${inv.storedPath}`);
          continue;
        }
        const name = `${String(added + 1).padStart(3, '0')}_${inv.originalFilename}`;
        archive.append(await this.storage.getStream(inv.storedPath), { name });
        added += 1;
      } catch (error) {
        this.logger.warn(`Skipping file for invoice ${inv.id}: ${String(error)}`);
      }
    }

    if (added === 0) {
      // Nothing to archive — add a note so the zip isn't empty/confusing.
      archive.append('No original files were available for the selected invoices.\n', {
        name: 'README.txt',
      });
    }
    void archive.finalize();
    return out;
  }
}
