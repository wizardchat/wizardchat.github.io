import type { AdminUser, AdminUserMessage, ChatListItem, ChatMemberInfo, ChatMessage, ChatRole, ChatSummary, User } from './types';

const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const CSRF_STORAGE_KEY = 'wizardchat.csrf';

let accessToken: string | null = null;

type TokenListener = () => void;
const tokenListeners = new Set<TokenListener>();

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
  for (const listener of tokenListeners) listener();
}

export function onAccessTokenChange(listener: TokenListener): () => void {
  tokenListeners.add(listener);
  return () => {
    tokenListeners.delete(listener);
  };
}

export function getCsrfToken(): string | null {
  return localStorage.getItem(CSRF_STORAGE_KEY);
}

export function storeSessionTokens(data: { accessToken: string; csrfToken: string }): void {
  accessToken = data.accessToken;
  localStorage.setItem(CSRF_STORAGE_KEY, data.csrfToken);
  for (const listener of tokenListeners) listener();
}

export function clearSessionTokens(): void {
  accessToken = null;
  localStorage.removeItem(CSRF_STORAGE_KEY);
  for (const listener of tokenListeners) listener();
}

export function getApiUrl(): string {
  return API_URL;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface AuthResponse {
  user: User;
  accessToken: string;
  csrfToken: string;
}

let refreshInFlight: Promise<AuthResponse | null> | null = null;

export function refreshSession(): Promise<AuthResponse | null> {
  refreshInFlight ??= (async () => {
    try {
      const csrf = getCsrfToken();
      const res = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        },
      });
      if (!res.ok) {
        clearSessionTokens();
        return null;
      }
      const data = (await res.json()) as AuthResponse;
      storeSessionTokens(data);
      return data;
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }
  const csrf = getCsrfToken();
  if (csrf) {
    headers.set('X-CSRF-Token', csrf);
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });

  const isAuthEndpoint = path.startsWith('/auth/login') || path.startsWith('/auth/register') || path.startsWith('/auth/refresh');
  if (res.status === 401 && retry && !isAuthEndpoint) {
    const refreshed = await refreshSession();
    if (refreshed) {
      return request<T>(path, init, false);
    }
    clearSessionTokens();
    throw new ApiError(401, 'Session expired');
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) {
    throw new ApiError(res.status, body?.error ?? `Request failed (${res.status})`);
  }
  return body as T;
}

export async function login(identifier: string, password: string): Promise<AuthResponse> {
  const data = await request<AuthResponse>(
    '/auth/login',
    { method: 'POST', body: JSON.stringify({ identifier, password }) },
    false,
  );
  storeSessionTokens(data);
  return data;
}

export async function register(username: string, email: string, password: string): Promise<AuthResponse> {
  const data = await request<AuthResponse>(
    '/auth/register',
    { method: 'POST', body: JSON.stringify({ username, email, password }) },
    false,
  );
  storeSessionTokens(data);
  return data;
}

export async function logout(): Promise<void> {
  try {
    await request<void>('/auth/logout', { method: 'POST' }, false);
  } finally {
    clearSessionTokens();
  }
}

export async function fetchMe(): Promise<User> {
  const data = await request<{ user: User }>('/auth/me');
  return data.user;
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await request<{ ok: boolean }>('/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export interface E2eKeyBundleResponse {
  publicKey: string | null;
  wrappedKey: string | null;
  kekSalt: string | null;
  kekParams: string | null;
  updatedAt: string | null;
}

export interface SearchResultUser {
  id: string;
  username: string;
  e2ePublicKey: string | null;
  avatarUrl: string | null;
}

export async function searchUsers(q: string): Promise<SearchResultUser[]> {
  const data = await request<{ users: SearchResultUser[] }>(
    `/users/search?q=${encodeURIComponent(q)}`,
  );
  return data.users;
}

export interface UploadSignature {
  cloudName: string;
  apiKey: string;
  signature: string;
  timestamp: number;
  folder: string;
  resourceType: 'image' | 'video' | 'raw';
}

export async function getUploadSignature(resourceType: 'image' | 'video' | 'raw'): Promise<UploadSignature> {
  return request<UploadSignature>('/uploads/signature', {
    method: 'POST',
    body: JSON.stringify({ resourceType }),
  });
}

export async function setUserAvatar(avatarUrl: string | null): Promise<string | null> {
  const data = await request<{ ok: boolean; avatarUrl: string | null }>('/users/me/avatar', {
    method: 'PUT',
    body: JSON.stringify({ avatarUrl }),
  });
  return data.avatarUrl;
}

export async function updateChatSettings(
  chatId: string,
  patch: { name?: string; avatarUrl?: string | null },
): Promise<ChatSummary> {
  const data = await request<{ ok: boolean; chat: ChatSummary | null }>(
    `/chats/${encodeURIComponent(chatId)}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
  );
  if (!data.chat) throw new ApiError(500, 'Update failed');
  return data.chat;
}

export async function renameGroup(chatId: string, name: string): Promise<ChatSummary> {
  return updateChatSettings(chatId, { name });
}

export function describeAttachment(a: { resourceType: string; name: string | null }): string {
  if (a.resourceType === 'image') return a.name ?? 'Image';
  if (a.resourceType === 'video') return a.name ?? 'Video';
  return a.name ?? 'File';
}

export async function getMyE2eKey(): Promise<E2eKeyBundleResponse> {
  return request('/users/me/e2e-key');
}

export async function putMyE2eKey(bundle: {
  publicKey: string;
  wrappedKey: string;
  kekSalt: string;
  kekParams: string;
}): Promise<void> {
  await request<{ ok: boolean }>('/users/me/e2e-key', {
    method: 'PUT',
    body: JSON.stringify(bundle),
  });
}

export async function getUserE2eKey(userId: string): Promise<{ publicKey: string | null }> {
  return request(`/users/${encodeURIComponent(userId)}/e2e-key`);
}

export async function listChats(): Promise<ChatListItem[]> {
  const data = await request<{ chats: ChatListItem[] }>('/chats');
  return data.chats;
}

export async function createDirectChat(target: { userId?: string; username?: string }): Promise<ChatSummary> {
  const data = await request<{ chat: ChatSummary }>('/chats/direct', {
    method: 'POST',
    body: JSON.stringify(target),
  });
  return data.chat;
}

export async function fetchChat(chatId: string): Promise<ChatSummary> {
  const data = await request<{ chat: ChatSummary }>(`/chats/${encodeURIComponent(chatId)}`);
  return data.chat;
}

export async function createGroup(name: string, userIds: string[]): Promise<ChatSummary> {
  const data = await request<{ chat: ChatSummary }>('/chats/groups', {
    method: 'POST',
    body: JSON.stringify({ name, userIds }),
  });
  return data.chat;
}

export async function addGroupMembers(chatId: string, userIds: string[]): Promise<ChatMemberInfo[]> {
  const data = await request<{ members: ChatMemberInfo[] }>(
    `/chats/${encodeURIComponent(chatId)}/members`,
    { method: 'POST', body: JSON.stringify({ userIds }) },
  );
  return data.members;
}

export async function removeGroupMember(chatId: string, userId: string): Promise<{ deleted?: boolean }> {
  return request(`/chats/${encodeURIComponent(chatId)}/members/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  });
}

export async function leaveGroup(chatId: string): Promise<{ deleted?: boolean }> {
  return request(`/chats/${encodeURIComponent(chatId)}/leave`, { method: 'POST' });
}

export async function setGroupMemberRole(
  chatId: string,
  userId: string,
  role: Exclude<ChatRole, 'owner'>,
): Promise<ChatMemberInfo[]> {
  const data = await request<{ members: ChatMemberInfo[] }>(
    `/chats/${encodeURIComponent(chatId)}/members/${encodeURIComponent(userId)}/role`,
    { method: 'PATCH', body: JSON.stringify({ role }) },
  );
  return data.members;
}

export async function fetchMessages(
  chatId: string,
  options: { before?: string; limit?: number } = {},
): Promise<{ messages: ChatMessage[]; hasMore: boolean; readCutoffs: { userId: string; lastReadAt: string }[] }> {
  const params = new URLSearchParams();
  if (options.before) params.set('before', options.before);
  if (options.limit) params.set('limit', String(options.limit));
  const qs = params.toString();
  return request(`/chats/${encodeURIComponent(chatId)}/messages${qs ? `?${qs}` : ''}`);
}

export async function markChatRead(chatId: string): Promise<{ readAt: string }> {
  return request(`/chats/${encodeURIComponent(chatId)}/read`, { method: 'POST' });
}

export async function editMessage(
  chatId: string,
  messageId: string,
  payload: { content: string; nonce?: string | null; isE2ee: boolean },
): Promise<{ ok: boolean; message: ChatMessage }> {
  return request(`/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ ...payload, nonce: payload.nonce ?? undefined }),
  });
}

export async function deleteMessage(chatId: string, messageId: string): Promise<{ ok: boolean }> {
  return request(`/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`, {
    method: 'DELETE',
  });
}

export async function fetchVapidPublicKey(): Promise<string | null> {
  const data = await request<{ publicKey: string | null }>('/push/vapid-public-key');
  return data.publicKey;
}

export interface PushSubscriptionBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export async function pushSubscribe(subscription: PushSubscriptionBody): Promise<void> {
  await request<{ ok: boolean }>('/push/subscribe', {
    method: 'POST',
    body: JSON.stringify(subscription),
  });
}

export async function pushUnsubscribe(endpoint: string): Promise<void> {
  try {
    await request<{ ok: boolean }>('/push/subscribe', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint }),
    });
  } catch {
    // Best-effort; the backend prunes dead endpoints on delivery failure anyway.
  }
}

export async function adminListUsers(
  q: string,
  limit: number,
  offset: number,
): Promise<{ users: AdminUser[]; total: number }> {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  return request(`/admin/users?${params.toString()}`);
}

export async function adminUpdateUser(
  userId: string,
  patch: { banned?: boolean; role?: 'USER' | 'ADMIN' },
): Promise<AdminUser> {
  const data = await request<{ user: AdminUser }>(`/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return data.user;
}

export async function adminDeleteUser(userId: string): Promise<{ username: string }> {
  const data = await request<{ deletedUser: { username: string } }>(
    `/admin/users/${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  );
  return data.deletedUser;
}

export async function adminResetPassword(userId: string): Promise<{ username: string; tempPassword: string }> {
  return request(`/admin/users/${encodeURIComponent(userId)}/reset-password`, { method: 'POST' });
}

export async function adminListUserMessages(
  userId: string,
  limit = 50,
): Promise<AdminUserMessage[]> {
  const data = await request<{ messages: AdminUserMessage[] }>(
    `/admin/users/${encodeURIComponent(userId)}/messages?limit=${limit}`,
  );
  return data.messages;
}

export async function adminDeleteUserMessage(userId: string, messageId: string): Promise<void> {
  await request(`/admin/users/${encodeURIComponent(userId)}/messages/${encodeURIComponent(messageId)}`, {
    method: 'DELETE',
  });
}

export async function adminClearUserMessages(userId: string): Promise<number> {
  const data = await request<{ deleted: number }>(
    `/admin/users/${encodeURIComponent(userId)}/messages`,
    { method: 'DELETE' },
  );
  return data.deleted;
}
