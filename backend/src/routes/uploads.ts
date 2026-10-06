import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { cloudinaryConfig } from '../config.js';
import { requireAuth } from '../middleware/auth.js';

export const uploadsRouter = Router();

uploadsRouter.use(requireAuth);

/**
 * Cloudinary signed-upload signature. Matches Cloudinary's documented
 * `api_sign_request`: sort params by key, join as `key=value&...`, append the
 * API secret, and SHA-1 it. The client uploads directly to
 * `https://api.cloudinary.com/v1_1/{cloud}/{resource_type}/upload` with the
 * returned fields + the file — the API secret never leaves the server.
 */
export function cloudinarySign(params: Record<string, string>, apiSecret: string): string {
  const query = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
  return createHash('sha1').update(`${query}${apiSecret}`).digest('hex');
}

const signatureSchema = z.object({
  resourceType: z.enum(['image', 'video', 'raw']).default('image'),
  folder: z.string().trim().max(120).optional(),
});

uploadsRouter.post('/signature', (req, res) => {
  const me = req.user;
  if (!me) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const config = cloudinaryConfig;
  if (!config) {
    res.status(503).json({ error: 'File uploads are not configured' });
    return;
  }

  const parsed = signatureSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid upload settings' });
    return;
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const folder = [
    'wizardchat',
    me.id,
    ...(parsed.data.folder ? [parsed.data.folder] : []),
  ].join('/');
  const params: Record<string, string> = { folder, timestamp: String(timestamp) };
  const signature = cloudinarySign(params, config.apiSecret);

  res.json({
    cloudName: config.cloudName,
    apiKey: config.apiKey,
    signature,
    timestamp,
    folder,
    resourceType: parsed.data.resourceType,
  });
});