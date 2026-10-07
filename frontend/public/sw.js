/* WizardChat service worker — delivers Web Push notifications. */
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : null;
  } catch {
    data = null;
  }

  const chatId = typeof data?.chatId === 'string' ? data.chatId : '';
  const title = typeof data?.title === 'string' && data.title ? data.title : 'WizardChat';
  const body = typeof data?.body === 'string' && data.body ? data.body : 'You have a new message';
  const url =
    typeof data?.url === 'string' && data.url
      ? data.url
      : `/#/${chatId ? `?pushchat=${encodeURIComponent(chatId)}` : ''}`;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: `wizardchat-${chatId || 'general'}`,
      renotify: Boolean(chatId),
      icon: '/icon-192.png',
      badge: '/icon-96.png',
      data: { chatId, url },
    }),
  );
});

function openOrFocus(url) {
  const target = new URL(url, self.location.origin).href;
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
    for (const client of windowClients) {
      if ('focus' in client && client.url === target) {
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url;
  if (typeof url !== 'string' || !url) return;
  event.waitUntil(openOrFocus(url));
});