import { fetchVapidPublicKey, pushSubscribe, pushUnsubscribe } from './chatApi';

const PREFERENCE_KEY = 'wizardchat.pushEnabled';

/** Per-browser preference for Web Push; persists across sessions. */
export function getPushPreference(): boolean {
  if (typeof localStorage === 'undefined') return true;
  return localStorage.getItem(PREFERENCE_KEY) !== '0';
}

export function setPushPreference(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(PREFERENCE_KEY, enabled ? '1' : '0');
}

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** True when this browser currently holds a subscribed push notification. */
export async function isPushActive(): Promise<boolean> {
  if (!pushSupported()) return false;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return false;
    const subscription = await registration.pushManager.getSubscription();
    return Boolean(subscription);
  } catch {
    return false;
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

function keyToBase64(key: ArrayBuffer | null): string | null {
  if (!key) return null;
  const bytes = new Uint8Array(key);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/**
 * Registers the service worker and subscribes this browser to Web Push,
 * then persists the subscription on the backend. Best-effort and never
 * throws; silently no-ops where push isn't available or configured.
 */
export async function enablePush(): Promise<void> {
  if (!pushSupported()) return;
  if (Notification.permission === 'denied') return;
  try {
    const registration = await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;

    const publicKey = await fetchVapidPublicKey();
    if (!publicKey) return;

    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      if (Notification.permission === 'default') {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;
      } else if (Notification.permission !== 'granted') {
        return;
      }
      try {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
        });
      } catch {
        return; // e.g. Firefox already has an active push service; user can re-log.
      }
    }

    const p256dh = keyToBase64(subscription.getKey('p256dh'));
    const auth = keyToBase64(subscription.getKey('auth'));
    if (!p256dh || !auth) return;

    await pushSubscribe({
      endpoint: subscription.endpoint,
      keys: { p256dh, auth },
    });
  } catch {
    // Never surface push setup errors in the UI.
  }
}

/** Removes the backend record and unsubscribes this browser. Best-effort. */
export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await pushUnsubscribe(subscription.endpoint);
      try {
        await subscription.unsubscribe();
      } catch {
        // Already unsubscribed.
      }
    }
  } catch {
    // No active registration.
  }
}