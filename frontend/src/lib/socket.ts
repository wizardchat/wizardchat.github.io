import { io, type Socket } from 'socket.io-client';

const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');

let socket: Socket | null = null;

export function connectSocket(token: string): Socket {
  if (socket) {
    socket.auth = { token };
    if (socket.connected) return socket;
    socket.connect();
    return socket;
  }

  socket = io(API_URL, {
    auth: { token },
    transports: ['websocket', 'polling'],
    autoConnect: true,
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  });

  return socket;
}

export function getSocket(): Socket | null {
  return socket;
}

export function updateSocketToken(token: string): void {
  if (socket) {
    socket.auth = { token };
  }
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
}
