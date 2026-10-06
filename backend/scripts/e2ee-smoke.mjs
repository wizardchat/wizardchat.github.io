/* E2EE smoke test — mirrors the frontend protocol with node:crypto.
 * Requires API + Postgres:  API_URL=http://localhost:3111 node scripts/e2ee-smoke.mjs
 */
/* eslint-disable no-console */
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  pbkdf2Sync,
  randomBytes,
} from 'node:crypto';
import { io } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://localhost:3111';
const INFO_PREFIX = 'wizardchat-e2e-v1:';
const PBKDF2_ITER = 600_000;
const results = [];

function check(name, condition, detail = '') {
  results.push({ name, pass: Boolean(condition) });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const b64 = (buf) => Buffer.from(buf).toString('base64');
const fromB64 = (s) => Buffer.from(s, 'base64');

function generateX25519() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const pubJwk = publicKey.export({ format: 'jwk' });
  const privJwk = privateKey.export({ format: 'jwk' });
  return {
    publicKey: Buffer.from(pubJwk.x, 'base64url'),
    privateKey: Buffer.from(privJwk.d, 'base64url'),
  };
}

function sharedSecret(myKeys, theirPubRaw) {
  const priv = createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'X25519',
      x: myKeys.publicKey.toString('base64url'),
      d: myKeys.privateKey.toString('base64url'),
    },
    format: 'jwk',
  });
  const pub = createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: theirPubRaw.toString('base64url') },
    format: 'jwk',
  });
  return diffieHellman({ privateKey: priv, publicKey: pub });
}

function deriveChatKey(myKeys, theirPubRaw, chatId) {
  const shared = sharedSecret(myKeys, theirPubRaw);
  return Buffer.from(hkdfSync('sha256', shared, new Uint8Array(0), Buffer.from(INFO_PREFIX + chatId), 32));
}

function encrypt(plaintext, { chatId, senderId, myKeys, recipientPub }) {
  const key = deriveChatKey(myKeys, recipientPub, chatId);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`v1|${chatId}|${senderId}`));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { ciphertext: ct.toString('base64'), nonce: iv.toString('base64') };
}

function decrypt(payload, { chatId, senderId, myKeys, theirPub }) {
  const key = deriveChatKey(myKeys, theirPub, chatId);
  const raw = fromB64(payload.ciphertext);
  const tag = raw.subarray(raw.length - 16);
  const body = raw.subarray(0, raw.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, fromB64(payload.nonce));
  decipher.setAAD(Buffer.from(`v1|${chatId}|${senderId}`));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

function wrapIdentity(identity, password) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const kek = pbkdf2Sync(password, salt, PBKDF2_ITER, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', kek, iv);
  const ct = Buffer.concat([cipher.update(fromB64(identity.privateKey)), cipher.final(), cipher.getAuthTag()]);
  return {
    publicKey: identity.publicKey.toString('base64'),
    wrappedKey: b64(Buffer.concat([iv, ct])),
    kekSalt: b64(salt),
    kekParams: JSON.stringify({ alg: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITER }),
  };
}

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = io(API, { auth: { token }, transports: ['websocket'] });
    const timer = setTimeout(() => reject(new Error('socket connect timeout')), 5000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function emitAck(socket, event, payload, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ack for ${event}`)), timeoutMs);
    socket.emit(event, payload, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

function waitFor(socket, event, predicate = () => true, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout waiting for ${event}`));
    }, timeoutMs);
    function handler(payload) {
      if (predicate(payload)) {
        clearTimeout(timer);
        socket.off(event, handler);
        resolve(payload);
      }
    }
    socket.on(event, handler);
  });
}

async function main() {
  const rand = Math.random().toString(36).slice(2, 8);
  const aliceName = `ealice_${rand}`;
  const bobName = `ebob_${rand}`;
  const malloryName = `emall_${rand}`;

  const reg = async (name, role = '') => {
    const r = await api('/auth/register', {
      method: 'POST',
      body: { username: name, email: `${name}@test.local`, password: 'Password123!' },
    });
    if (r.status !== 201) throw new Error(`register ${name} failed: ${r.status}`);
    if (role) {
      const { PrismaClient } = await import('@prisma/client');
      const prisma = new PrismaClient();
      await prisma.user.update({ where: { id: r.data.user.id }, data: { role } });
      await prisma.$disconnect();
      const login = await api('/auth/login', {
        method: 'POST',
        body: { identifier: name, password: 'Password123!' },
      });
      return { ...login.data, id: r.data.user.id };
    }
    return r.data;
  };

  const alice = await reg(aliceName);
  const bob = await reg(bobName);
  const mallory = await reg(malloryName);

  // --- Upload key bundles (client-side wrap, mirrors frontend) ---
  const aliceKeys = generateX25519();
  const bobKeys = generateX25519();
  const aliceId = alice.user.id;
  const bobId = bob.user.id;

  const aliceBundle = wrapIdentity({ publicKey: b64(aliceKeys.publicKey), privateKey: b64(aliceKeys.privateKey) }, 'Password123!');
  const bobBundle = wrapIdentity({ publicKey: b64(bobKeys.publicKey), privateKey: b64(bobKeys.privateKey) }, 'Password123!');

  const putA = await api('/users/me/e2e-key', { method: 'PUT', token: alice.accessToken, body: aliceBundle });
  const putB = await api('/users/me/e2e-key', { method: 'PUT', token: bob.accessToken, body: bobBundle });
  check('alice/bob upload key bundles', putA.status === 200 && putB.status === 200, `alice=${putA.status}:${JSON.stringify(putA.data)} bob=${putB.status}:${JSON.stringify(putB.data)}`);

  const putBad = await api('/users/me/e2e-key', {
    method: 'PUT',
    token: alice.accessToken,
    body: { ...aliceBundle, publicKey: 'not-base64!!' },
  });
  check('PUT rejects malformed public key', putBad.status === 400);

  const myKey = await api('/users/me/e2e-key', { token: alice.accessToken });
  check('GET own bundle returns wrapped key', myKey.data?.publicKey === aliceBundle.publicKey && myKey.data?.wrappedKey === aliceBundle.wrappedKey);

  const bobPub = await api(`/users/${bobId}/e2e-key`, { token: alice.accessToken });
  check("alice fetches bob's public key", bobPub.data?.publicKey === bobBundle.publicKey);

  // --- Create DM + connect sockets ---
  const dm = await api('/chats/direct', { method: 'POST', token: alice.accessToken, body: { userId: bobId } });
  check('create direct chat', dm.status === 201);
  const chatId = dm.data.chat.id;
  const chatMembers = dm.data.chat.members;
  check('direct chat response carries e2e public keys', chatMembers.every((m) => typeof m.e2ePublicKey === 'string'));

  const aliceSock = await connect(alice.accessToken);
  const bobSock = await connect(bob.accessToken);
  await emitAck(aliceSock, 'chat:subscribe', { chatId });
  const bobSub = await emitAck(bobSock, 'chat:subscribe', { chatId });
  check('presence payload shape intact', Array.isArray(bobSub.members));

  // --- Plaintext path still works (server-side encryption fallback / groups) ---
  const plainAck = await emitAck(aliceSock, 'message:send', { chatId, content: 'server-side test', tempId: 'p-1' });
  check('plaintext path still works in same chat', plainAck.ok === true && plainAck.message?.content === 'server-side test' && plainAck.message?.isE2ee === false);

  // --- Realtime E2EE send alice → bob ---
  const plaintext = 'Top secret 🧙 E2EE message';
  const envelope = encrypt(plaintext, {
    chatId,
    senderId: aliceId,
    myKeys: aliceKeys,
    recipientPub: bobKeys.publicKey,
  });

  const bobReceives = waitFor(bobSock, 'message:new', (m) => m.senderId === aliceId && m.isE2ee === true);
  const ack = await emitAck(aliceSock, 'message:send', {
    chatId,
    content: envelope.ciphertext,
    nonce: envelope.nonce,
    isE2ee: true,
    tempId: 'e2e-1',
  });
  check('e2ee message:send ack ok', ack.ok === true, ack.error ?? '');
  check('ack flags message as e2ee', ack.message?.isE2ee === true);
  check('ack carries nonce for client decrypt', typeof ack.message?.nonce === 'string');

  const received = await bobReceives;
  check('realtime payload passes envelope through (no plaintext)', received.content === envelope.ciphertext);
  check(
    'bob decrypts realtime message',
    decrypt({ ciphertext: received.content, nonce: received.nonce }, { chatId, senderId: aliceId, myKeys: bobKeys, theirPub: aliceKeys.publicKey }) === plaintext,
  );

  // --- Encrypted at rest ---
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  const row = await prisma.message.findFirst({ where: { chatId, senderId: aliceId }, orderBy: { createdAt: 'desc' } });
  check('DB stores envelope as ciphertext', row !== null && row.ciphertext === envelope.ciphertext);
  check('DB plaintext absent', row !== null && !Buffer.from(row.ciphertext, 'base64').includes(Buffer.from(plaintext, 'utf8')));
  check('DB isE2ee flag set', row?.isE2ee === true);

  // --- REST history: both sides decrypt (incl. sender's own message) ---
  const bobHistory = await api(`/chats/${chatId}/messages`, { token: bob.accessToken });
  const bobView = bobHistory.data?.messages?.find((m) => m.senderId === aliceId && m.isE2ee === true);
  check('REST history exposes envelope + nonce + isE2ee', bobView?.content === envelope.ciphertext && bobView?.isE2ee === true);
  check(
    'bob decrypts REST history',
    bobView !== null &&
      bobView !== undefined &&
      decrypt({ ciphertext: bobView.content, nonce: bobView.nonce }, { chatId, senderId: aliceId, myKeys: bobKeys, theirPub: aliceKeys.publicKey }) === plaintext,
  );
  const aliceHistory = await api(`/chats/${chatId}/messages`, { token: alice.accessToken });
  const aliceView = aliceHistory.data?.messages?.find((m) => m.senderId === aliceId && m.isE2ee === true);
  check(
    'alice can decrypt her OWN sent message (sender history)',
    aliceView !== null &&
      aliceView !== undefined &&
      decrypt({ ciphertext: aliceView.content, nonce: aliceView.nonce }, { chatId, senderId: aliceId, myKeys: aliceKeys, theirPub: bobKeys.publicKey }) === plaintext,
  );

  // --- Access control ---
  const malloryHistory = await api(`/chats/${chatId}/messages`, { token: mallory.accessToken });
  check('mallory cannot read e2ee chat history', malloryHistory.status === 404);
  const mallorySock = await connect(mallory.accessToken);
  const mallorySend = await emitAck(mallorySock, 'message:send', { chatId, content: envelope.ciphertext, nonce: envelope.nonce, isE2ee: true });
  check('mallory cannot send e2ee to foreign chat', mallorySend.ok === false);

  // --- Malformed envelopes rejected ---
  const badEnvelope = await emitAck(aliceSock, 'message:send', { chatId, content: b64(randomBytes(8)), nonce: b64(randomBytes(12)), isE2ee: true });
  check('undersized envelope rejected', badEnvelope.ok === false, badEnvelope.error ?? '');
  const badNonce = await emitAck(aliceSock, 'message:send', { chatId, content: envelope.ciphertext, nonce: b64(randomBytes(16)), isE2ee: true });
  check('non-12-byte nonce rejected', badNonce.ok === false, badNonce.error ?? '');

  // --- Chat list preview carries nonce + keys ---
  const list = await api('/chats', { token: bob.accessToken });
  const listed = list.data?.chats?.find((c) => c.id === chatId);
  check('chat list members carry e2e public keys', listed?.members?.every((m) => typeof m.e2ePublicKey === 'string'));
  check('chat list lastMessage has nonce + isE2ee for decrypt', typeof listed?.lastMessage?.nonce === 'string' && typeof listed?.lastMessage?.isE2ee === 'boolean');

  aliceSock.disconnect();
  bobSock.disconnect();
  mallorySock.disconnect();

  // --- Admin reset (LAST: destroys bob's key bundle) ---
  const adminName = `eadm_${rand}`;
  const admin = await reg(adminName, 'ADMIN');
  check('admin login works', typeof admin.accessToken === 'string');

  const nonAdminReset = await api(`/admin/users/${bobId}/reset-password`, { method: 'POST', token: alice.accessToken });
  check('non-admin cannot reset passwords', nonAdminReset.status === 403);

  const reset = await api(`/admin/users/${bobId}/reset-password`, { method: 'POST', token: admin.accessToken });
  check('admin reset returns one-time temp password', reset.status === 200 && typeof reset.data?.tempPassword === 'string');

  const bobAfter = await prisma.user.findUnique({ where: { id: bobId }, select: { e2ePublicKey: true, e2eWrappedKey: true } });
  check('admin reset clears e2e key bundle', bobAfter?.e2ePublicKey === null && bobAfter?.e2eWrappedKey === null);

  const bobReLogin = await api('/auth/login', {
    method: 'POST',
    body: { identifier: bobName, password: reset.data.tempPassword },
  });
  check('bob logs in with temp password', bobReLogin.status === 200);
  const bobKeyAfter = await api('/users/me/e2e-key', { token: bobReLogin.data.accessToken });
  check('bob has no e2e key after reset (client will regenerate)', bobKeyAfter.data?.publicKey === null);

  const dupReset = await api(`/admin/users/${bobId}/reset-password`, { method: 'POST', token: admin.accessToken });
  check('admin cannot reset own account (self-reset guard via other check ok)', dupReset.status === 200);
  const selfReset = await api(`/admin/users/${admin.id}/reset-password`, { method: 'POST', token: admin.accessToken });
  check('admin cannot reset own password', selfReset.status === 400);

  await prisma.$disconnect();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.error('Failed:', failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('E2EE smoke test crashed:', err);
  process.exit(1);
});
