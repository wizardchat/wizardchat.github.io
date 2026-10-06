/* Realtime smoke test — run with the API + Postgres up:
 *   DATABASE_URL=... node backend/scripts/realtime-smoke.mjs
 */
/* eslint-disable no-console */
import { io } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://localhost:3111';
const results = [];

function check(name, condition, detail = '') {
  results.push({ name, pass: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
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

function emitAck(socket, event, payload, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ack for ${event}`)), timeoutMs);
    socket.emit(event, payload, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

async function main() {
  const rand = Math.random().toString(36).slice(2, 8);
  const aliceName = `alice_${rand}`;
  const bobName = `bob_${rand}`;
  const malloryName = `mallory_${rand}`;

  // --- Register three users ---
  const regAlice = await api('/auth/register', {
    method: 'POST',
    body: { username: aliceName, email: `${aliceName}@test.local`, password: 'Password123!' },
  });
  const regBob = await api('/auth/register', {
    method: 'POST',
    body: { username: bobName, email: `${bobName}@test.local`, password: 'Password123!' },
  });
  const regMallory = await api('/auth/register', {
    method: 'POST',
    body: { username: malloryName, email: `${malloryName}@test.local`, password: 'Password123!' },
  });
  check('register alice/bob/mallory', regAlice.status === 201 && regBob.status === 201 && regMallory.status === 201);

  const aliceTok = regAlice.data.accessToken;
  const bobTok = regBob.data.accessToken;
  const malloryTok = regMallory.data.accessToken;
  const aliceId = regAlice.data.user.id;
  const bobId = regBob.data.user.id;

  // --- User search ---
  const search = await api(`/users/search?q=${bobName.slice(0, 6)}`, { token: aliceTok });
  check('user search finds bob', search.data?.users?.some((u) => u.id === bobId));

  // --- Create DM ---
  const dm = await api('/chats/direct', { method: 'POST', token: aliceTok, body: { userId: bobId } });
  check('create direct chat', dm.status === 201 || dm.status === 200, `status ${dm.status}`);
  const chatId = dm.data.chat.id;
  const dmAgain = await api('/chats/direct', { method: 'POST', token: bobTok, body: { username: aliceName } });
  check('direct chat is idempotent', dmAgain.data?.chat?.id === chatId);

  // --- Connect sockets ---
  const aliceSock = await connect(aliceTok);
  const bobSock = await connect(bobTok);
  const mallorySock = await connect(malloryTok);
  check('alice/bob/mallory sockets connected', true);

  // --- Unauthorized socket rejected ---
  let unauthorized = false;
  try {
    await connect('not-a-valid-token');
  } catch {
    unauthorized = true;
  }
  check('socket with bad token rejected', unauthorized);

  // --- Subscribe ---
  const subBob = await emitAck(bobSock, 'chat:subscribe', { chatId });
  check('bob subscribes to chat', subBob.ok === true);
  const subAlice = await emitAck(aliceSock, 'chat:subscribe', { chatId });
  check('alice subscribes to chat', subAlice.ok === true);

  // --- Presence: bob online visible to alice via subscribe members ---
  check(
    'presence shows bob online for alice',
    (subAlice.members ?? []).some((m) => m.userId === bobId && m.online === true),
  );

  // --- Send message alice → bob ---
  const bobReceives = waitFor(bobSock, 'message:new', (m) => m.senderId === aliceId);
  const sendAck = await emitAck(aliceSock, 'message:send', {
    chatId,
    content: 'Hello Bob, phase 3 works!',
    tempId: 'tmp-1',
  });
  check('message:send ack ok', sendAck.ok === true, sendAck.error ?? '');
  check('send ack echoes tempId', sendAck.message?.tempId === 'tmp-1');
  const received = await bobReceives;
  check('bob receives decrypted content', received.content === 'Hello Bob, phase 3 works!', received.content ?? '');
  check('message payload has sender username', received.sender?.username === aliceName);

  // --- Mallory cannot send into the chat ---
  const mallorySend = await emitAck(mallorySock, 'message:send', { chatId, content: 'intrusion' });
  check('mallory cannot send to foreign chat', mallorySend.ok === false, mallorySend.error ?? '');
  const mallorySub = await emitAck(mallorySock, 'chat:subscribe', { chatId });
  check('mallory cannot subscribe to foreign chat', mallorySub.ok === false);

  // --- Typing ---
  const bobSeesTyping = waitFor(bobSock, 'typing', (p) => p.userId === aliceId && p.isTyping === true);
  aliceSock.emit('typing', { chatId, isTyping: true });
  await bobSeesTyping;
  check('bob sees alice typing', true);

  // --- Read receipt ---
  const aliceSeesRead = waitFor(aliceSock, 'messages:read', (p) => p.userId === bobId);
  bobSock.emit('message:read', { chatId });
  const readEvent = await aliceSeesRead;
  check('alice receives read receipt', typeof readEvent.readAt === 'string');

  // --- REST history (decrypted) ---
  const history = await api(`/chats/${chatId}/messages`, { token: bobTok });
  check(
    'history returns decrypted message',
    history.data?.messages?.some((m) => m.content === 'Hello Bob, phase 3 works!'),
  );
  const malloryHistory = await api(`/chats/${chatId}/messages`, { token: malloryTok });
  check('mallory cannot read foreign chat history', malloryHistory.status === 404, `status ${malloryHistory.status}`);

  // --- Chat list ---
  const bobChats = await api('/chats', { token: bobTok });
  const listed = bobChats.data?.chats?.find((c) => c.id === chatId);
  check('bob chat list contains DM with alice', listed?.name === aliceName);
  check('bob chat list has last message preview', listed?.lastMessage?.content === 'Hello Bob, phase 3 works!');

  // --- Encrypted at rest ---
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  const stored = await prisma.message.findFirst({
    where: { chatId, senderId: aliceId },
    orderBy: { createdAt: 'desc' },
  });
  check('DB stores ciphertext, not plaintext', stored !== null && !stored.ciphertext.includes('Hello Bob'));
  check('DB stores base64 nonce', stored !== null && stored.nonce.length > 0);
  await prisma.$disconnect();

  aliceSock.disconnect();
  bobSock.disconnect();
  mallorySock.disconnect();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.error('Failed:', failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
