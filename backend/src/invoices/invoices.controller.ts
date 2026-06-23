import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { InvoiceResponseDto } from './dto/invoice-response.dto';
import { InvoiceStatsDto } from './dto/invoice-stats.dto';
import {
  INVOICE_SORT_KEYS,
  InvoicePageDto,
  ListInvoicesQueryDto,
} from './dto/invoice-page.dto';
import { UpdateInvoiceDto } from './dto/update-invoice.dto';
import { ExportService } from './export.service';
import { InvoicesService } from './invoices.service';
import { StorageService } from '../storage/storage.service';
import {
  ExportFilter,
  ExportFormat,
  INVOICE_STATUSES,
  InvoiceStatus,
} from './invoice.types';
import { multerConfig } from './multer.config';

@ApiTags('invoices')
@ApiBearerAuth()
@Controller('invoices')
export class InvoicesController {
  constructor(
    private readonly invoicesService: InvoicesService,
    private readonly exportService: ExportService,
    private readonly storage: StorageService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Upload an invoice (PDF or image)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
      },
      required: ['file'],
    },
  })
  @ApiCreatedResponse({ type: InvoiceResponseDto })
  @UseInterceptors(FileInterceptor('file', multerConfig))
  async upload(
    @UploadedFile() file: Express.Multer.File,
  ): Promise<InvoiceResponseDto> {
    if (!file) {
      throw new BadRequestException('No file uploaded (field name: "file").');
    }
    const invoice = await this.invoicesService.createFromUpload(file);
    return InvoiceResponseDto.fromEntity(invoice);
  }

  @Get()
  @ApiOperation({
    summary: 'List invoices (newest first)',
    description:
      'Without `page`: returns the full list (bare array, legacy). With `page`: returns a ' +
      'paginated page `{ items, total, page, limit }` filtered + sorted in SQL.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, description: '1-based; omit for the full list.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size (1–100, default 25).' })
  @ApiQuery({ name: 'status', required: false, enum: INVOICE_STATUSES })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'sort', required: false, enum: INVOICE_SORT_KEYS })
  @ApiQuery({ name: 'dir', required: false, enum: ['asc', 'desc'] })
  @ApiOkResponse({ type: InvoiceResponseDto, isArray: true })
  async list(
    @Query() q: ListInvoicesQueryDto,
  ): Promise<InvoiceResponseDto[] | InvoicePageDto> {
    // Legacy path: no page → the whole list as a bare array (kept for the
    // auth prefetch, export, and any client that hasn't moved to pagination).
    if (q.page === undefined) {
      const invoices = await this.invoicesService.findAll(q.status);
      return invoices.map(InvoiceResponseDto.fromEntity);
    }
    const { items, total, page, limit } = await this.invoicesService.findPaginated({
      page: q.page,
      limit: q.limit ?? 25,
      status: q.status,
      search: q.search,
      sort: q.sort ?? 'createdAt',
      dir: q.dir ?? 'desc',
    });
    return { items: items.map(InvoiceResponseDto.fromEntity), total, page, limit };
  }

  @Get('stats')
  @ApiOperation({ summary: 'Aggregate invoice statistics' })
  @ApiOkResponse({ type: InvoiceStatsDto })
  getStats(): Promise<InvoiceStatsDto> {
    return this.invoicesService.getStats();
  }

  // NOTE: this static route MUST stay above the `:id` route, otherwise
  // "export" would be captured as an id and rejected by ParseUUIDPipe.
  @Get('export/:format')
  @ApiOperation({ summary: 'Export filtered invoices as xlsx, csv, or a zip of originals' })
  @ApiQuery({ name: 'status', required: false, enum: INVOICE_STATUSES })
  @ApiQuery({ name: 'vendor', required: false })
  @ApiQuery({ name: 'minTotal', required: false, type: Number })
  @ApiQuery({ name: 'maxTotal', required: false, type: Number })
  @ApiQuery({ name: 'search', required: false })
  @ApiOkResponse({ description: 'The export file (spreadsheet or zip archive)' })
  async export(
    @Param('format') format: string,
    @Query('status') status: string | undefined,
    @Query('vendor') vendor: string | undefined,
    @Query('minTotal') minTotal: string | undefined,
    @Query('maxTotal') maxTotal: string | undefined,
    @Query('search') search: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const fmt = format.toLowerCase();
    if (fmt !== 'xlsx' && fmt !== 'csv' && fmt !== 'zip') {
      throw new BadRequestException(`Unsupported export format "${format}". Use xlsx, csv, or zip.`);
    }
    if (status && !INVOICE_STATUSES.includes(status as InvoiceStatus)) {
      throw new BadRequestException(`Invalid status "${status}".`);
    }
    const toNum = (v: string | undefined): number | undefined => {
      if (v === undefined || v.trim() === '') return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const filter: ExportFilter = {
      status: status as InvoiceStatus | undefined,
      vendor,
      minTotal: toNum(minTotal),
      maxTotal: toNum(maxTotal),
      search,
    };

    const invoices = await this.invoicesService.queryForExport(filter);

    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `invoices_${stamp}.${fmt}`;
    const contentType: Record<ExportFormat, string> = {
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      csv: 'text/csv; charset=utf-8',
      zip: 'application/zip',
    };
    res.set({
      'Content-Type': contentType[fmt],
      'Content-Disposition': `attachment; filename="${filename}"`,
    });

    const stream =
      fmt === 'xlsx'
        ? await this.exportService.toXlsx(invoices)
        : fmt === 'csv'
          ? this.exportService.toCsv(invoices)
          : await this.exportService.toZip(invoices);
    return new StreamableFile(stream);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single invoice by id' })
  @ApiOkResponse({ type: InvoiceResponseDto })
  async getOne(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<InvoiceResponseDto> {
    const invoice = await this.invoicesService.findOne(id);
    return InvoiceResponseDto.fromEntity(invoice);
  }

  @Get(':id/file')
  @ApiOperation({ summary: 'Download/preview the original uploaded file' })
  @ApiOkResponse({ description: 'The file as uploaded (PDF or image)' })
  async getFile(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const invoice = await this.invoicesService.findOne(id);
    if (!(await this.storage.exists(invoice.storedPath))) {
      throw new NotFoundException('Stored file is missing.');
    }
    res.set({
      'Content-Type': invoice.mimeType,
      'Content-Disposition': `inline; filename="${encodeURIComponent(
        invoice.originalFilename,
      )}"`,
    });
    return new StreamableFile(await this.storage.getStream(invoice.storedPath));
  }

  @Post(':id/retry')
  @ApiOperation({ summary: 'Retry a failed invoice (re-queues it)' })
  @ApiOkResponse({ type: InvoiceResponseDto })
  async retry(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<InvoiceResponseDto> {
    const invoice = await this.invoicesService.retry(id);
    return InvoiceResponseDto.fromEntity(invoice);
  }

  @Post(':id/reprocess')
  @ApiOperation({ summary: 'Re-run extraction on an invoice (any status) to re-check its data' })
  @ApiOkResponse({ type: InvoiceResponseDto })
  async reprocess(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<InvoiceResponseDto> {
    const invoice = await this.invoicesService.reprocess(id);
    return InvoiceResponseDto.fromEntity(invoice);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Correct extracted fields on an invoice' })
  @ApiOkResponse({ type: InvoiceResponseDto })
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateInvoiceDto,
  ): Promise<InvoiceResponseDto> {
    const invoice = await this.invoicesService.updateExtractedFields(id, dto);
    return InvoiceResponseDto.fromEntity(invoice);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an invoice and its stored file' })
  @ApiNoContentResponse({ description: 'Invoice deleted' })
  async remove(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.invoicesService.remove(id);
  }
}
