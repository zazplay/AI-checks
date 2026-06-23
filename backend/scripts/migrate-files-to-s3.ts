/**
 * One-off migration: move every on-disk uploaded file into the S3/R2 bucket and
 * rewrite its `storedPath` to `s3:<key>`. Idempotent — rows already on S3
 * (storedPath starts with `s3:`) are skipped.
 *
 * Usage (from backend/):
 *   1. Fill the S3_* vars in .env (and DATABASE_URL).
 *   2. npm run migrate:files-to-s3
 *
 * It uses the same env as the app; STORAGE_DRIVER does NOT need to be `s3` to run
 * this (it always writes to the bucket from the S3_* vars). After it finishes,
 * set STORAGE_DRIVER=s3 so the app reads/writes S3 going forward.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { extname } from 'path';
import { randomUUID } from 'crypto';
import {
  S3Client,
  PutObjectCommand,
} from '@aws-sdk/client-s3';

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function contentType(file: string): string {
  const e = extname(file).toLowerCase();
  if (e === '.pdf') return 'application/pdf';
  if (e === '.png') return 'image/png';
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}

async function main() {
  const databaseUrl = reqEnv('DATABASE_URL');
  const bucket = reqEnv('S3_BUCKET');
  const s3 = new S3Client({
    endpoint: reqEnv('S3_ENDPOINT'),
    region: process.env.S3_REGION ?? 'auto',
    credentials: {
      accessKeyId: reqEnv('S3_ACCESS_KEY_ID'),
      secretAccessKey: reqEnv('S3_SECRET_ACCESS_KEY'),
    },
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
  });

  const db = new Client({ connectionString: databaseUrl });
  await db.connect();

  const { rows } = await db.query<{ id: string; storedPath: string; originalFilename: string }>(
    `SELECT id, "storedPath", "originalFilename" FROM invoices WHERE "storedPath" NOT LIKE 's3:%'`,
  );
  console.log(`Found ${rows.length} on-disk file(s) to migrate.`);

  let migrated = 0;
  let missing = 0;
  for (const row of rows) {
    if (!existsSync(row.storedPath)) {
      console.warn(`  · ${row.id}: file missing on disk (${row.storedPath}) — skipped`);
      missing += 1;
      continue;
    }
    const buffer = await readFile(row.storedPath);
    const key = `${randomUUID()}${extname(row.originalFilename || row.storedPath)}`;
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType(row.originalFilename || row.storedPath),
      }),
    );
    await db.query(`UPDATE invoices SET "storedPath" = $1 WHERE id = $2`, [`s3:${key}`, row.id]);
    console.log(`  ✓ ${row.id}: ${row.storedPath} → s3:${key}`);
    migrated += 1;
  }

  await db.end();
  console.log(`\nDone. Migrated ${migrated}, missing ${missing}, skipped (already s3) ${'n/a'}.`);
  console.log('Now set STORAGE_DRIVER=s3 in .env so the app uses the bucket.');
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
