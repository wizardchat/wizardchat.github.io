import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { createApp } from './app.js';
import { corsOrigins, env } from './config.js';
import { initPush } from './lib/push.js';
import { attachRealtime } from './realtime/socket.js';

initPush();

const app = createApp();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: corsOrigins,
    credentials: true,
  },
  transports: ['websocket', 'polling'],
});

app.set('io', io);
attachRealtime(io);

httpServer.listen(env.PORT, () => {
  console.info(`wizardchat-api listening on http://0.0.0.0:${env.PORT} (${env.NODE_ENV})`);
});
