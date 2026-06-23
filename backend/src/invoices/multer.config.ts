import { BadRequestException } from '@nestjs/common';
import { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { memoryStorage } from 'multer';

const MAX_UPLOAD_SIZE_MB = Number(process.env.MAX_UPLOAD_SIZE_MB ?? 10);

const ALLOWED_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg'];

/**
 * Buffer the upload in memory (not on disk) so the StorageService decides where
 * it lands — local disk or an S3-compatible bucket. The file arrives as
 * `file.buffer`; the controller hands it to StorageService.save(). Bounded by
 * MAX_UPLOAD_SIZE_MB, so a 10 MB cap in RAM per request is safe.
 */
export const multerConfig: MulterOptions = {
  storage: memoryStorage(),
  limits: {
    // multer's fileSize limit is in bytes.
    fileSize: MAX_UPLOAD_SIZE_MB * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new BadRequestException(
          `Unsupported file type "${file.mimetype}". Allowed: PDF, PNG, JPEG.`,
        ),
        false,
      );
    }
  },
};
