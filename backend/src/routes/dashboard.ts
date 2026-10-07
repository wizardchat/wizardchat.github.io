import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { getChatWithMembership, memberRole, type ChatWithMembers } from '../lib/chat.js';

export const dashboardRouter = Router({ mergeParams: true });

export const dashboardRowSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    id: z.string().min(1).max(40),
    text: z.string().min(1).max(500),
  }),
  z.object({
    kind: z.literal('status'),
    id: z.string().min(1).max(40),
    label: z.string().max(80).nullable().optional(),
    url: z.string().url().max(2048),
    jsonPath: z.string().max(160).optional().nullable(),
    refreshSec: z.number().int().min(5).max(600).optional().default(30),
  }),
  z.object({
    kind: z.literal('button'),
    id: z.string().min(1).max(40),
    label: z.string().min(1).max(60),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
    url: z.string().url().max(2048),
    headers: z.record(z.string(), z.string().max(500)).optional().default({}),
    body: z.string().max(2000).optional().nullable(),
    confirm: z.string().max(160).optional().nullable(),
  }),
]);

const dashboardConfigSchema = z.object({
  sections: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        title: z.string().max(60).nullable().optional(),
        rows: z.array(dashboardRowSchema).max(30),
      }),
    )
    .max(20),
});

const ROW_SECRET_KEYS = new Set(['authorization', 'cookie', 'x-api-key', 'api-key', 'x-auth-token']);
const MAX_BODY = 250_000;

interface ParsedTextRow { id: string; kind: 'text'; text: string }
interface ParsedStatusRow { id: string; kind: 'status'; label?: string | null; url: string; jsonPath?: string | null; refreshSec?: number }
interface ParsedButtonRow {
  id: string;
  kind: 'button';
  label: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | null;
  confirm?: string | null;
}
type ParsedDashboardRow = ParsedTextRow | ParsedStatusRow | ParsedButtonRow;
interface ParsedDashboardConfig {
  sections: Array<{ id: string; title?: string | null; rows: ParsedDashboardRow[] }>;
}

/** Removes any configured secrets before blocks leave the server to non-editors. */
function redactBlocks(blocks: unknown, canEdit: boolean): unknown {
  if (canEdit) return blocks;
  const config = dashboardConfigSchema.safeParse(blocks);
  if (!config.success) return { sections: [] };
  const data = config.data as ParsedDashboardConfig;
  return {
    sections: data.sections.map((section) => ({
      ...section,
      rows: section.rows.map((row) => {
        if (row.kind !== 'button') return row;
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(row.headers)) {
          if (!ROW_SECRET_KEYS.has(key.toLowerCase())) {
            headers[key] = value;
          }
        }
        return { ...row, headers, body: undefined };
      }),
    })),
  };
}

function resolveJsonPath(json: unknown, path: string): unknown {
  if (!path) return json;
  let value: unknown = json;
  for (const part of path.split('.')) {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value) && /^\d+$/.test(part)) {
      value = value[Number(part)];
    } else if (typeof value === 'object' && value !== null) {
      value = (value as Record<string, unknown>)[part];
    } else {
      return null;
    }
  }
  return value;
}

function stringifyValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }
  return String(value);
}

async function runRowRequest(row: Exclude<z.infer<typeof dashboardRowSchema>, { kind: 'text' }>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  const isButton = row.kind === 'button';
  try {
    const headers = new Headers(isButton ? (row.headers ?? {}) : {});
    if (isButton && row.body !== undefined && row.method !== 'GET') {
      headers.set('Content-Type', 'application/json');
    }
    const res = await fetch(row.url, {
      method: isButton ? row.method : 'GET',
      headers,
      signal: controller.signal,
      ...(isButton && row.body ? { body: row.body } : {}),
    });
    const text = await res.text().catch(() => '');
    const truncated = text.slice(0, MAX_BODY);
    if (isButton) {
      return { ok: true, status: res.status, text: truncated.slice(0, 500) };
    }
    let json: unknown = null;
    try {
      json = JSON.parse(truncated);
    } catch {
      json = null;
    }
    const value = row.jsonPath ? resolveJsonPath(json, row.jsonPath) : json;
    return { ok: true, status: res.status, value: stringifyValue(value), raw: truncated.slice(0, 1200) };
  } catch {
    return { ok: false, error: 'Unreachable (timeout or network error)', status: null, value: null, text: null };
  } finally {
    clearTimeout(timer);
  }
}

type DashboardRes = { status: (c: number) => { json: (b: unknown) => void } };
type DashboardReq = { params: Record<string, string | undefined>; user?: { id: string } };

async function loadChatOr404(req: DashboardReq, res: DashboardRes): Promise<ChatWithMembers | null> {
  const chatId = req.params.id;
  const userId = req.user?.id;
  if (!chatId || !userId) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  const chat = await getChatWithMembership(chatId, userId);
  if (!chat) {
    res.status(404).json({ error: 'Chat not found' });
    return null;
  }
  if (chat.members.some((m) => m.user.banned)) {
    res.status(403).json({ error: 'Chat unavailable' });
    return null;
  }
  return chat;
}

function canEditDashboard(chat: ChatWithMembers, userId: string): boolean {
  const role = memberRole(chat, userId);
  return role === 'owner' || role === 'admin';
}

dashboardRouter.get('/', async (req, res) => {
  const chat = await loadChatOr404(req, res);
  if (!chat) return;
  const dashboard = await prisma.chatDashboard.findUnique({ where: { chatId: chat.id } });
  const canEdit = canEditDashboard(chat, req.user!.id);
  res.json({
    dashboard: dashboard
      ? {
          iconUrl: dashboard.iconUrl,
          updatedBy: dashboard.updatedById,
          updatedAt: dashboard.updatedAt.toISOString(),
          blocks: redactBlocks(dashboard.blocks, canEdit),
          canEdit,
        }
      : { iconUrl: null, updatedBy: null, updatedAt: null, blocks: { sections: [] }, canEdit },
  });
});

dashboardRouter.put('/', async (req, res) => {
  const chat = await loadChatOr404(req, res);
  if (!chat) return;
  if (!canEditDashboard(chat, req.user!.id)) {
    res.status(403).json({ error: 'Only the chat owner or admins can edit the dashboard' });
    return;
  }
  const parsed = z
    .object({ iconUrl: z.string().url().max(2048).nullable().optional(), blocks: dashboardConfigSchema })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid dashboard' });
    return;
  }
  const { iconUrl, blocks } = parsed.data;
  const dashboard = await prisma.chatDashboard.upsert({
    where: { chatId: chat.id },
    create: { chatId: chat.id, iconUrl: iconUrl ?? null, blocks, updatedById: req.user!.id },
    update: { iconUrl: iconUrl ?? null, blocks, updatedById: req.user!.id },
  });
  res.json({ ok: true, dashboard: { chatId: dashboard.chatId, iconUrl: dashboard.iconUrl, updatedAt: dashboard.updatedAt.toISOString() } });
});

dashboardRouter.delete('/', async (req, res) => {
  const chat = await loadChatOr404(req, res);
  if (!chat) return;
  if (!canEditDashboard(chat, req.user!.id)) {
    res.status(403).json({ error: 'Only the chat owner or admins can edit the dashboard' });
    return;
  }
  await prisma.chatDashboard.deleteMany({ where: { chatId: chat.id } });
  res.json({ ok: true });
});

dashboardRouter.post('/run', async (req, res) => {
  const chat = await loadChatOr404(req, res);
  if (!chat) return;
  const dashboard = await prisma.chatDashboard.findUnique({ where: { chatId: chat.id } });
  if (!dashboard) {
    res.status(404).json({ error: 'No dashboard configured' });
    return;
  }
  const parsed = z.object({ rowId: z.string().min(1).max(40) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input' });
    return;
  }
  const config = dashboardConfigSchema.safeParse(dashboard.blocks);
  if (!config.success) {
    res.status(400).json({ error: 'Dashboard is misconfigured' });
    return;
  }
  const row = config.data.sections.flatMap((s) => s.rows).find((r) => r.id === parsed.data.rowId);
  if (!row || row.kind === 'text') {
    res.status(404).json({ error: 'Row not found' });
    return;
  }
  res.json(await runRowRequest(row));
});