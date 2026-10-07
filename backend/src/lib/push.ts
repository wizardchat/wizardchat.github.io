import webpush from 'web-push';
import type { Server } from 'socket.io';
import { pushEnabled, vapidConfig } from '../config.js';
import { prisma } from '../db.js';

/** No-op when VAPID keys aren't configured; safe to call at boot. */
export function initPush(): void {
  if (!pushEnabled || !vapidConfig) return;
  webpush.setVapidDetails(vapidConfig.subject, vapidConfig.publicKey, vapidConfig.privateKey);
}

export function pushConfigured(): boolean {
  return pushEnabled;
}

export interface PushMessageData {
  title: string;
  body: string;
  chatId: string;
  /** Client-side URL (hash-route friendly) to open when the notification is clicked. */
  url: string;
}

/** userIds of sockets currently live in `chat:chatId` (they will get `message:new` live). */
function viewersOfChat(io: Server, chatId: string): Set<string> {
  const userIds = new Set<string>();
  const namespace = io.of('/');
  const room = namespace.adapter.rooms.get(`chat:${chatId}`);
  if (!room) return userIds;
  for (const socketId of room) {
    const socket = namespace.sockets.get(socketId);
    const userId = socket?.data.user?.id;
    if (userId) userIds.add(userId);
  }
  return userIds;
}

/**
 * Sends a push to every subscription belonging to `recipientUserIds`, except
 * users who are currently viewing the chat (their tab already shows the new
 * message). Fire-and-forget: never throws, prunes dead subscriptions on 404/410.
 */
export async function notifyUsersViaPush(
  io: Server,
  chatId: string,
  recipientUserIds: string[],
  data: PushMessageData,
): Promise<void> {
  if (!pushEnabled || recipientUserIds.length === 0) return;

  const viewers = viewersOfChat(io, chatId);
  const targets = recipientUserIds.filter((userId) => !viewers.has(userId));
  if (targets.length === 0) return;

  const subscriptions = await prisma.pushSubscription
    .findMany({ where: { userId: { in: targets } } })
    .catch(() => []);
  if (subscriptions.length === 0) return;

  const payload = JSON.stringify(data);
  await Promise.allSettled(subscriptions.map((subscription) => sendPush(subscription, payload)));
}

async function sendPush(
  subscription: { endpoint: string; keysP256dh: string; keysAuth: string },
  payload: string,
): Promise<void> {
  try {
    const res = await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: { p256dh: subscription.keysP256dh, auth: subscription.keysAuth } },
      payload,
      { TTL: 120 },
    );
    if (res.statusCode === 404 || res.statusCode === 410) {
      await pruneSub(subscription.endpoint);
    }
  } catch (err) {
    const statusCode = (err as { statusCode?: number } | null)?.statusCode;
    if (statusCode === 404 || statusCode === 410) {
      await pruneSub(subscription.endpoint);
    } else {
      console.warn(`[push] delivery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function pruneSub(endpoint: string): Promise<void> {
  try {
    await prisma.pushSubscription.delete({ where: { endpoint } });
  } catch {
    // Already gone.
  }
}