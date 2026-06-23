import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { InvoiceResponseDto } from '../invoices/dto/invoice-response.dto';
import { Invoice } from '../invoices/entities/invoice.entity';

/**
 * Single-room broadcast gateway: every connected client gets every invoice
 * lifecycle event. The frontend merges these straight into its React Query
 * cache (no polling). The JWT travels in the Socket.IO handshake `auth.token`;
 * when AUTH_PASSWORD is unset, auth is disabled (same rule as the HTTP guard).
 */
@WebSocketGateway({ cors: { origin: true } })
export class EventsGateway implements OnGatewayConnection {
  private readonly logger = new Logger(EventsGateway.name);

  @WebSocketServer()
  private server: Server;

  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    if (!this.config.get<string>('AUTH_PASSWORD')) return; // auth disabled

    const token =
      (client.handshake.auth?.token as string | undefined) ??
      (client.handshake.headers.authorization?.split(' ')[1] as
        | string
        | undefined);
    try {
      if (!token) throw new Error('missing token');
      await this.jwt.verifyAsync(token);
    } catch {
      this.logger.warn('Rejected socket connection: invalid/missing token');
      client.disconnect(true);
    }
  }

  emitCreated(invoice: Invoice): void {
    this.server?.emit('invoice.created', InvoiceResponseDto.fromEntity(invoice));
  }

  emitUpdated(invoice: Invoice): void {
    this.server?.emit('invoice.updated', InvoiceResponseDto.fromEntity(invoice));
  }

  emitDeleted(id: string): void {
    this.server?.emit('invoice.deleted', { id });
  }
}
