import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Invoice } from '../invoices/entities/invoice.entity';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        // Auto-create the schema from entities (no migrations in this project).
        // On by default in dev; on a fresh managed DB (Railway/Render) the env
        // is "production", so allow an explicit DB_SYNCHRONIZE=true to keep it
        // on there too — otherwise the tables would never be created.
        const sync =
          config.get('DB_SYNCHRONIZE') === 'true' ||
          config.get('NODE_ENV') !== 'production';
        // Managed Postgres usually requires SSL; enable it via DB_SSL=true.
        const ssl =
          config.get('DB_SSL') === 'true'
            ? { rejectUnauthorized: false }
            : undefined;
        return {
          type: 'postgres' as const,
          url: config.get<string>('DATABASE_URL'),
          entities: [Invoice],
          synchronize: sync,
          ssl,
        };
      },
    }),
  ],
})
export class DatabaseModule {}
