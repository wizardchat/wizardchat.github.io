import cors from 'cors';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { corsOrigins } from './config.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { chatsRouter } from './routes/chats.js';
import { healthRouter } from './routes/health.js';
import { uploadsRouter } from './routes/uploads.js';
import { usersRouter } from './routes/users.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        // Allow non-browser clients (no Origin header) and the allowlisted origins.
        if (!origin || corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error(`Blocked by CORS: ${origin}`));
      },
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(apiLimiter);

  app.use(healthRouter);
  app.use('/auth', authRouter);
  app.use('/users', usersRouter);
  app.use('/chats', chatsRouter);
  app.use('/uploads', uploadsRouter);
  app.use('/admin', adminRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof Error && err.message.startsWith('Blocked by CORS:')) {
      res.status(403).json({ error: 'Origin not allowed' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
