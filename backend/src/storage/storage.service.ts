import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { createReadStream, existsSync, mkdirSync } from 'fs';
import { readFile, unlink, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { extname, isAbsolute, join, resolve } from 'path';
import { Readable } from 'stream';

/**
 * Storage abstraction for the original uploaded files. Two backends, chosen by
 * `STORAGE_DRIVER`:
 *   - `disk` (default): files live under UPLOAD_DIR; the stored reference is the
 *     file path (backwards-compatible with rows created before S3 existed).
 *   - `s3`: files live in an S3-compatible bucket (e.g. Cloudflare R2); the
 *     stored reference is `s3:<key>`.
 *
 * A row's `storedPath` is whatever `save()` returned, so old disk rows and new
 * S3 rows coexist — `getStream`/`getBytes`/`remove`/`exists` dispatch on the
 * `s3:` prefix, falling back to disk for everything else.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly driver: 's3' | 'disk';
  private readonly uploadDir: string;
  private s3?: S3Client;
  private bucket?: string;

  constructor(private readonly config: ConfigService) {
    this.driver = config.get<string>('STORAGE_DRIVER') === 's3' ? 's3' : 'disk';
    this.uploadDir = config.get<string>('UPLOAD_DIR') ?? './uploads';
  }

  onModuleInit() {
    if (this.driver === 's3') {
      const endpoint = this.config.get<string>('S3_ENDPOINT');
      const bucket = this.config.get<string>('S3_BUCKET');
      const accessKeyId = this.config.get<string>('S3_ACCESS_KEY_ID');
      const secretAccessKey = this.config.get<string>('S3_SECRET_ACCESS_KEY');
      if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
        throw new Error(
          'STORAGE_DRIVER=s3 but S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are not all set.',
        );
      }
      this.bucket = bucket;
      this.s3 = new S3Client({
        endpoint,
        region: this.config.get<string>('S3_REGION') ?? 'auto',
        credentials: { accessKeyId, secretAccessKey },
        forcePathStyle: this.config.get<string>('S3_FORCE_PATH_STYLE') !== 'false',
      });
      this.logger.log(`Storage driver: s3 (bucket "${bucket}")`);
    } else {
      if (!existsSync(this.uploadDir)) mkdirSync(this.uploadDir, { recursive: true });
      this.logger.log(`Storage driver: disk (${resolve(this.uploadDir)})`);
    }
  }

  /** True when an uploaded file is stored in S3 (vs. on local disk). */
  private isS3(ref: string): boolean {
    return ref.startsWith('s3:');
  }

  private keyOf(ref: string): string {
    return ref.slice(3); // strip "s3:"
  }

  /**
   * Persist an uploaded buffer and return its storage reference (to be saved as
   * the invoice's `storedPath`). Generates a UUID name + the original extension.
   */
  async save(buffer: Buffer, originalName: string, mimeType: string): Promise<string> {
    const key = `${randomUUID()}${extname(originalName)}`;
    if (this.driver === 's3') {
      await this.s3!.send(
        new PutObjectCommand({
          Bucket: this.bucket!,
          Key: key,
          Body: buffer,
          ContentType: mimeType,
        }),
      );
      return `s3:${key}`;
    }
    const filePath = join(this.uploadDir, key);
    await writeFile(filePath, buffer);
    return filePath;
  }

  /** Read the full bytes of a stored file (used by extraction). */
  async getBytes(ref: string): Promise<Buffer> {
    if (this.isS3(ref)) {
      const res = await this.s3!.send(
        new GetObjectCommand({ Bucket: this.bucket!, Key: this.keyOf(ref) }),
      );
      return Buffer.from(await res.Body!.transformToByteArray());
    }
    return readFile(ref);
  }

  /** A readable stream of a stored file (used by download + zip export). */
  async getStream(ref: string): Promise<Readable> {
    if (this.isS3(ref)) {
      const res = await this.s3!.send(
        new GetObjectCommand({ Bucket: this.bucket!, Key: this.keyOf(ref) }),
      );
      return res.Body as Readable;
    }
    return createReadStream(ref);
  }

  /** True if the stored file still exists. */
  async exists(ref: string): Promise<boolean> {
    if (this.isS3(ref)) {
      try {
        await this.s3!.send(
          new HeadObjectCommand({ Bucket: this.bucket!, Key: this.keyOf(ref) }),
        );
        return true;
      } catch {
        return false;
      }
    }
    // disk path may be relative to cwd or absolute
    return existsSync(isAbsolute(ref) ? ref : ref);
  }

  /** Best-effort delete of a stored file (swallows "not found"). */
  async remove(ref: string): Promise<void> {
    try {
      if (this.isS3(ref)) {
        await this.s3!.send(
          new DeleteObjectCommand({ Bucket: this.bucket!, Key: this.keyOf(ref) }),
        );
      } else if (existsSync(ref)) {
        await unlink(ref);
      }
    } catch (error) {
      this.logger.warn(`Failed to delete stored file ${ref}: ${String(error)}`);
    }
  }
}
