import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { EventsGateway } from './events.gateway';

/**
 * Provides the WebSocket gateway. Its own JwtModule mirrors AuthModule's config
 * so the handshake can verify the same tokens. Exported so InvoicesModule can
 * emit lifecycle events.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET') ?? 'dev-insecure-jwt-secret',
      }),
    }),
  ],
  providers: [EventsGateway],
  exports: [EventsGateway],
})
export class EventsModule {}
