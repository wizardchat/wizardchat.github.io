import { Router } from 'express';
import { prisma } from '../db.js';

export const healthRouter = Router();

/** Liveness probe — does not touch any dependency. */
healthRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'wizardchat-api' });
});

/** Readiness probe — verifies the database is reachable. */
healthRouter.get('/ready', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ready', database: 'up' });
  } catch (error) {
    console.error('Database readiness check failed:', error);
    res.status(503).json({ status: 'not_ready', database: 'down' });
  }
});
