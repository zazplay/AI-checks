import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AiModule } from './ai/ai.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AssistantModule } from './assistant/assistant.module';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { InvoicesModule } from './invoices/invoices.module';
import { ProcessingModule } from './processing/processing.module';
import { StorageModule } from './storage/storage.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    StorageModule,
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        // Prefer a full REDIS_URL (managed Redis on Railway/Render bundles host,
        // port and password in it); parse it into ioredis fields. Fall back to
        // discrete host/port/password for local dev.
        const url = config.get<string>('REDIS_URL');
        if (url) {
          const u = new URL(url);
          return {
            connection: {
              host: u.hostname,
              port: Number(u.port || 6379),
              password: decodeURIComponent(u.password) || undefined,
              username: decodeURIComponent(u.username) || undefined,
            },
          };
        }
        return {
          connection: {
            host: config.get<string>('REDIS_HOST') ?? 'localhost',
            port: Number(config.get<string>('REDIS_PORT') ?? 6379),
            password: config.get<string>('REDIS_PASSWORD') || undefined,
          },
        };
      },
    }),
    AiModule,
    AuthModule,
    DatabaseModule,
    InvoicesModule,
    ProcessingModule,
    AssistantModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
