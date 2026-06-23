import { io, type Socket } from 'socket.io-client';
import { API_URL } from './api';

// No transports pin: let Socket.IO negotiate (polling fallback keeps dev
// setups without a clean WS upgrade path working). Connection is managed by
// AuthProvider so the handshake carries the API key.
export const socket: Socket = io(API_URL, { autoConnect: false });

export function connectSocket(token: string | null): void {
  socket.auth = token ? { token } : {};
  if (!socket.connected) socket.connect();
}

export function disconnectSocket(): void {
  socket.disconnect();
}
