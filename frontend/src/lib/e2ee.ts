import { x25519 } from '@noble/curves/ed25519.js';
import type { ChatListItem, ChatMessage } from './types';

/**
 * End-to-end encryption for 1-on-1 DMs.
 *
 * Protocol (static-static ECDH, "pairwise" scheme):
 *   shared   = X25519(myPrivate, theirPublic)          (identical on both sides)
 *   key      = HKDF-SHA256(shared, info = "wizardchat-e2e-v1:" + chatId)
 *   envelope = AES-256-GCM(key, iv, plaintext, aad = "v1|chatId|senderId")
 *
 * Both parties can derive the same key from their own private key and the
 * counterparty's public key, so each side can decrypt its own sent messages
 * too (needed for history). The server only ever stores envelope + IV.
 *
 * The private key never leaves the device in plaintext: at registration /
 * first login it is generated client-side and uploaded wrapped with
 * AES-GCM(PBKDF2-SHA256(password, salt)) so it can be unwrapped on any
 * device by entering the password.
 */

const INFO_PREFIX = 'wizardchat-e2e-v1:';
const DEFAULT_ITERATIONS = 600_000;
const LOCKED_PLACEHOLDER = '🔒';

export interface Identity {
  publicKey: string;
  privateKey: string;
}

export interface E2eKeyBundle {
  publicKey: string;
  wrappedKey: string;
  kekSalt: string;
  kekParams: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function toB64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromB64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

async function deriveKek(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', textEncoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Wraps an existing identity's private key under the given password. */
export async function wrapIdentity(identity: Identity, password: string): Promise<E2eKeyBundle> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const kek = await deriveKek(password, salt, DEFAULT_ITERATIONS);
  const wrapped = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, fromB64(identity.privateKey)),
  );
  return {
    publicKey: identity.publicKey,
    wrappedKey: toB64(concat(iv, wrapped)),
    kekSalt: toB64(salt),
    kekParams: JSON.stringify({ alg: 'PBKDF2', hash: 'SHA-256', iterations: DEFAULT_ITERATIONS }),
  };
}

/** Generates a fresh X25519 keypair and wraps it for server-side storage. */
export async function generateIdentity(password: string): Promise<{ identity: Identity; bundle: E2eKeyBundle }> {
  const keypair = x25519.keygen();
  const identity: Identity = { publicKey: toB64(keypair.publicKey), privateKey: toB64(keypair.secretKey) };
  const bundle = await wrapIdentity(identity, password);
  return { identity, bundle };
}

/** Unwraps a server-stored bundle with the user's password. Null on failure. */
export async function unwrapIdentity(password: string, bundle: E2eKeyBundle): Promise<Identity | null> {
  try {
    const params = JSON.parse(bundle.kekParams) as { alg?: unknown; hash?: unknown; iterations?: unknown };
    if (params.alg !== 'PBKDF2' || params.hash !== 'SHA-256') return null;
    const iterations = params.iterations;
    if (typeof iterations !== 'number' || !Number.isInteger(iterations) || iterations < 100_000 || iterations > 2_000_000) {
      return null;
    }
    const wrapped = fromB64(bundle.wrappedKey);
    if (wrapped.length < 28) return null;
    const iv = wrapped.slice(0, 12);
    const ciphertext = wrapped.slice(12);
    const kek = await deriveKek(password, fromB64(bundle.kekSalt), iterations);
    const privateKey = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, kek, ciphertext));
    if (privateKey.length !== 32) return null;
    return { publicKey: bundle.publicKey, privateKey: toB64(privateKey) };
  } catch {
    return null;
  }
}

async function deriveChatKey(identity: Identity, counterpartyPublicKey: string, chatId: string): Promise<CryptoKey> {
  const shared = x25519.getSharedSecret(fromB64(identity.privateKey), fromB64(counterpartyPublicKey));
  const base = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: textEncoder.encode(INFO_PREFIX + chatId) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function aad(chatId: string, senderId: string): Uint8Array<ArrayBuffer> {
  return textEncoder.encode(`v1|${chatId}|${senderId}`);
}

export interface EncryptedPayload {
  ciphertext: string;
  nonce: string;
}

export async function encryptMessage(
  plaintext: string,
  args: { chatId: string; senderId: string; myIdentity: Identity; recipientPublicKey: string },
): Promise<EncryptedPayload> {
  const key = await deriveChatKey(args.myIdentity, args.recipientPublicKey, args.chatId);
  const iv = randomBytes(12);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(args.chatId, args.senderId) },
      key,
      textEncoder.encode(plaintext),
    ),
  );
  return { ciphertext: toB64(ciphertext), nonce: toB64(iv) };
}

export async function decryptMessage(
  payload: EncryptedPayload,
  args: { chatId: string; senderId: string; myIdentity: Identity; counterpartyPublicKey: string },
): Promise<string | null> {
  try {
    const key = await deriveChatKey(args.myIdentity, args.counterpartyPublicKey, args.chatId);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(payload.nonce), additionalData: aad(args.chatId, args.senderId) },
      key,
      fromB64(payload.ciphertext),
    );
    return textDecoder.decode(plaintext);
  } catch {
    return null;
  }
}

const storageKey = (userId: string) => `wizardchat.e2e.${userId}`;

export function loadIdentity(userId: string): Identity | null {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Identity>;
    if (typeof parsed.publicKey !== 'string' || typeof parsed.privateKey !== 'string') return null;
    return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
  } catch {
    return null;
  }
}

export function saveIdentity(userId: string, identity: Identity): void {
  localStorage.setItem(storageKey(userId), JSON.stringify(identity));
}

export function clearIdentity(userId: string): void {
  localStorage.removeItem(storageKey(userId));
}

/**
 * In a DIRECT chat both members share the pairwise key, so the counterparty
 * is simply the other member — for both sent and received messages.
 * Returns the displayable plaintext, or a lock placeholder.
 */
export async function decryptChatMessage(
  message: Pick<ChatMessage, 'content' | 'isE2ee' | 'nonce' | 'chatId' | 'senderId'>,
  members: ChatListItem['members'],
  meId: string,
): Promise<string | null> {
  if (!message.isE2ee) return message.content;
  const identity = loadIdentity(meId);
  const other = members.find((m) => m.userId !== meId);
  if (!identity || !other?.e2ePublicKey || !message.nonce || message.content === null) {
    return message.content === null ? null : LOCKED_PLACEHOLDER;
  }
  const plaintext = await decryptMessage(
    { ciphertext: message.content, nonce: message.nonce },
    { chatId: message.chatId, senderId: message.senderId, myIdentity: identity, counterpartyPublicKey: other.e2ePublicKey },
  );
  return plaintext ?? LOCKED_PLACEHOLDER;
}

export { LOCKED_PLACEHOLDER };
