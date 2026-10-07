/* Message menu smoke test (edit + delete, permission matrix, E2EE passthrough,
 * socket events) — run with the API + Postgres up:
 *   DATABASE_URL=... API_URL=... node backend/scripts/menu-smoke.mjs
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
  const aliceName = `mnu_a_${rand}`;
  const bobName = `mnu_b_${rand}`;
  const carolName = `mnu_c_${rand}`;

  const regAlice = await api('/auth/register', {
    method: 'POST',
    body: { username: aliceName, email: `${aliceName}@test.local`, password: 'Password123!' },
  });
  const regBob = await api('/auth/register', {
    method: 'POST',
    body: { username: bobName, email: `${bobName}@test.local`, password: 'Password123!' },
  });
  const regCarol = await api('/auth/register', {
    method: 'POST',
    body: { username: carolName, email: `${carolName}@test.local`, password: 'Password123!' },
  });
  check('register alice/bob/carol', regAlice.status === 201 && regBob.status === 201 && regCarol.status === 201);

  const aTok = regAlice.data.accessToken;
  const bTok = regBob.data.accessToken;
  const cTok = regCarol.data.accessToken;
  const aId = regAlice.data.user.id;
  const bId = regBob.data.user.id;

  const dm = await api('/chats/direct', { method: 'POST', token: aTok, body: { userId: bId } });
  const dmId = dm.data?.chat?.id;
  check('alice creates DM with bob', [200, 201].includes(dm.status) && Boolean(dmId));

  const aSock = await connect(aTok);
  const bSock = await connect(bTok);
  await emitAck(aSock, 'chat:subscribe', { chatId: dmId });
  await emitAck(bSock, 'chat:subscribe', { chatId: dmId });

  // --- Edit: sender only, plaintext ---
  const sentA1 = await emitAck(aSock, 'message:send', {
    chatId: dmId,
    content: 'menu original',
    tempId: 't1',
    isE2ee: false,
  });
  check('alice sends plaintext DM message', sentA1.ok === true);
  const msgId = sentA1.message?.id;

  const bUpdated = waitFor(bSock, 'messages:updated', (p) => p.messageId === msgId || p.message?.id === msgId);
  const editByAlice = await api(`/chats/${dmId}/messages/${msgId}`, {
    method: 'PATCH',
    token: aTok,
    body: { content: 'menu edited', isE2ee: false },
  });
  check('alice edits own message', editByAlice.status === 200 && Boolean(editByAlice.data?.message?.editedAt));
  const updatedPayload = await bUpdated;
  check('bob receives messages:updated event', Boolean(updatedPayload));
  check('edited message content updated', updatedPayload.message?.content === 'menu edited');

  const editByBob = await api(`/chats/${dmId}/messages/${msgId}`, {
    method: 'PATCH',
    token: bTok,
    body: { content: 'sneaky edit', isE2ee: false },
  });
  check('recipient cannot edit sender message (403)', editByBob.status === 403);

  // --- Edit: E2EE passthrough (server just rotates the nonce, keeps ciphertext) ---
  const e2eeCipher1 = Buffer.alloc(20, 0xb0).toString('base64');
  const e2eeNonce1 = Buffer.alloc(12, 0x07).toString('base64');
  const sentE2ee = await emitAck(aSock, 'message:send', {
    chatId: dmId,
    content: e2eeCipher1,
    nonce: e2eeNonce1,
    tempId: 't2',
    isE2ee: true,
  });
  check('alice sends E2EE DM message', sentE2ee.ok === true);
  const e2eeId = sentE2ee.message?.id;
  const bE2eeUpdated = waitFor(bSock, 'messages:updated', (p) => p.message?.id === e2eeId);
  const e2eeCipher2 = Buffer.alloc(24, 0x41).toString('base64');
  const e2eeNonce2 = Buffer.alloc(12, 0x31).toString('base64');
  const editE2ee = await api(`/chats/${dmId}/messages/${e2eeId}`, {
    method: 'PATCH',
    token: aTok,
    body: { content: e2eeCipher2, nonce: e2eeNonce2, isE2ee: true },
  });
  check('E2EE message edit accepted with nonce', editE2ee.status === 200 && Boolean(editE2ee.data?.message?.editedAt));
  const e2eePayload = await bE2eeUpdated;
  check('E2EE edit event carries new nonce + ciphertext', e2eePayload.message?.nonce === e2eeNonce2);

  // --- Delete: sender only; recipient forbidden ---
  const delByBob = await api(`/chats/${dmId}/messages/${msgId}`, { method: 'DELETE', token: bTok });
  check('recipient cannot delete sender message (403)', delByBob.status === 403);

  const bDeleted = waitFor(bSock, 'messages:deleted', (p) => p.messageIds?.includes(msgId));
  const delByAlice = await api(`/chats/${dmId}/messages/${msgId}`, { method: 'DELETE', token: aTok });
  check('sender deletes own message', delByAlice.status === 200);
  await bDeleted;
  check('bob receives messages:deleted event', true);

  const reDelete = await api(`/chats/${dmId}/messages/${msgId}`, { method: 'DELETE', token: aTok });
  check('re-deleting a deleted message returns 404', reDelete.status === 404);

  // --- Group: owner/admin may edit/delete any member's; plain member cannot ---
  const group = await api('/chats/groups', {
    method: 'POST',
    token: aTok,
    body: { name: `menu-group-${rand}`, userIds: [bId] },
  });
  const gId = group.data?.chat?.id;
  await emitAck(aSock, 'chat:subscribe', { chatId: gId });
  await emitAck(bSock, 'chat:subscribe', { chatId: gId });
  const sentBob = await emitAck(bSock, 'message:send', {
    chatId: gId,
    content: 'bobs group msg',
    tempId: 't3',
    isE2ee: false,
  });
  const gMsgId = sentBob.message?.id;

  const cars = await api(`/chats/${gId}/members`, {
    method: 'POST',
    token: aTok,
    body: { userIds: [regCarol.data.user.id] },
  });
  check('alice adds carol to group', cars.status === 200);

  const carolEdit = await api(`/chats/${gId}/messages/${gMsgId}`, {
    method: 'PATCH',
    token: cTok,
    body: { content: 'carol edit', isE2ee: false },
  });
  check('group member cannot edit another member message (403)', carolEdit.status === 403);

  const carolDel = await api(`/chats/${gId}/messages/${gMsgId}`, { method: 'DELETE', token: cTok });
  check('group member cannot delete another member message (403)', carolDel.status === 403);

  const ownerEdit = await api(`/chats/${gId}/messages/${gMsgId}`, {
    method: 'PATCH',
    token: aTok,
    body: { content: 'owner rewrote', isE2ee: false },
  });
  check('group owner can edit member message', ownerEdit.status === 200 && ownerEdit.data?.message?.content === 'owner rewrote');

  const ownerDel = await api(`/chats/${gId}/messages/${gMsgId}`, { method: 'DELETE', token: aTok });
  check('group owner can delete member message', ownerDel.status === 200);

  aSock.disconnect();
  bSock.disconnect();

  const failures = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});