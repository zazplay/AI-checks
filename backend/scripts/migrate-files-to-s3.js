"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const pg_1 = require("pg");
const promises_1 = require("fs/promises");
const fs_1 = require("fs");
const path_1 = require("path");
const crypto_1 = require("crypto");
const client_s3_1 = require("@aws-sdk/client-s3");
function reqEnv(name) {
    const v = process.env[name];
    if (!v) {
        console.error(`Missing required env var: ${name}`);
        process.exit(1);
    }
    return v;
}
function contentType(file) {
    const e = (0, path_1.extname)(file).toLowerCase();
    if (e === '.pdf')
        return 'application/pdf';
    if (e === '.png')
        return 'image/png';
    if (e === '.jpg' || e === '.jpeg')
        return 'image/jpeg';
    return 'application/octet-stream';
}
async function main() {
    const databaseUrl = reqEnv('DATABASE_URL');
    const bucket = reqEnv('S3_BUCKET');
    const s3 = new client_s3_1.S3Client({
        endpoint: reqEnv('S3_ENDPOINT'),
        region: process.env.S3_REGION ?? 'auto',
        credentials: {
            accessKeyId: reqEnv('S3_ACCESS_KEY_ID'),
            secretAccessKey: reqEnv('S3_SECRET_ACCESS_KEY'),
        },
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    });
    const db = new pg_1.Client({ connectionString: databaseUrl });
    await db.connect();
    const { rows } = await db.query(`SELECT id, "storedPath", "originalFilename" FROM invoices WHERE "storedPath" NOT LIKE 's3:%'`);
    console.log(`Found ${rows.length} on-disk file(s) to migrate.`);
    let migrated = 0;
    let missing = 0;
    for (const row of rows) {
        if (!(0, fs_1.existsSync)(row.storedPath)) {
            console.warn(`  · ${row.id}: file missing on disk (${row.storedPath}) — skipped`);
            missing += 1;
            continue;
        }
        const buffer = await (0, promises_1.readFile)(row.storedPath);
        const key = `${(0, crypto_1.randomUUID)()}${(0, path_1.extname)(row.originalFilename || row.storedPath)}`;
        await s3.send(new client_s3_1.PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: buffer,
            ContentType: contentType(row.originalFilename || row.storedPath),
        }));
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
//# sourceMappingURL=migrate-files-to-s3.js.map