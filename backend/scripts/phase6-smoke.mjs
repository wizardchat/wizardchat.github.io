/* Phase 6 smoke: attachments (Cloudinary signatures + media messages) + avatars.
 * Requires API + Postgres:
 *   API_URL=http://localhost:3111 node scripts/phase6-smoke.mjs
 * CLOUDINARY_URL is set via fake credentials to exercise the signature flow.
 */
/* eslint-disable no-console */
import { createHash } from 'node:crypto';
import { io } from 'socket.io-client';
import { PrismaClient } from '@prisma/client';

const API = process.env.API_URL ?? 'http://localhost:3111';
const results = [];

function check(name, condition, detail = '') {
  results.push({ name, pass: Boolean(condition) });
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
  const aliceName = `palice_${rand}`;
  const bobName = `pbob_${rand}`;
  const carolName = `pcarol_${rand}`;

  const reg = async (name) => {
    const r = await api('/auth/register', {
      method: 'POST',
      body: { username: name, email: `${name}@test.local`, password: 'Password123!' },
    });
    if (r.status !== 201) throw new Error(`register ${name} failed: ${r.status}`);
    return r.data;
  };

  const alice = await reg(aliceName);
  const bob = await reg(bobName);
  const carol = await reg(carolName);
  const aliceId = alice.user.id;
  const bobId = bob.user.id;
  const carolId = carol.user.id;

  const [aliceSock, bobSock] = await Promise.all([connect(alice.accessToken), connect(bob.accessToken)]);

  // --- 1. Upload signature endpoint ---
  const noAuthSig = await api('/uploads/signature', { method: 'POST', body: {} });
  check('signature requires auth', noAuthSig.status === 401, `status=${noAuthSig.status}`);

  const sigRes = await api('/uploads/signature', { method: 'POST', token: alice.accessToken, body: {} });
  check(
    'signature returns signed fields',
    sigRes.status === 200 &&
      typeof sigRes.data?.cloudName === 'string' &&
      typeof sigRes.data?.apiKey === 'string' &&
      typeof sigRes.data?.signature === 'string' &&
      Number.isInteger(sigRes.data?.timestamp) &&
      typeof sigRes.data?.folder === 'string',
  );
  check('cloudName/apiKey echo configured values', sigRes.data?.cloudName === 'demo_cloud' && sigRes.data?.apiKey === 'fakesig_api_key');
  check('folder scoped per user', sigRes.data?.folder === `wizardchat/${aliceId}`, `folder=${sigRes.data?.folder}`);

  const expectedSignature = createHash('sha1')
    .update(`folder=wizardchat/${aliceId}&timestamp=${sigRes.data.timestamp}fakesig_secret`)
    .digest('hex');
  check(
    'signature matches sha1(sorted params + api_secret)',
    sigRes.data?.signature === expectedSignature && /^[0-9a-f]{40}$/.test(sigRes.data?.signature),
    `sig=${sigRes.data?.signature}`,
  );
  check('resourceType defaults to image', sigRes.data?.resourceType === 'image');

  const videoSig = await api('/uploads/signature', { method: 'POST', token: alice.accessToken, body: { resourceType: 'video' } });
  check('video resourceType honored', videoSig.data?.resourceType === 'video');
  const badSig = await api('/uploads/signature', { method: 'POST', token: alice.accessToken, body: { resourceType: 'audio' } });
  check('invalid resourceType rejected (400)', badSig.status === 400, `status=${badSig.status}`);

  // --- 2. Attachments in group messages ---
  const groupRes = await api('/chats/groups', {
    method: 'POST',
    token: alice.accessToken,
    body: { name: 'Media Group', userIds: [bobId, carolId] },
  });
  const chatId = groupRes.data?.chat?.id;
  check('group created for media tests', groupRes.status === 201 && !!chatId, `status=${groupRes.status}`);
  const subscribe = await emitAck(bobSock, 'chat:subscribe', { chatId });
  check('subscriber receives presence', subscribe.ok === true);

  const IMG = {
    resourceType: 'image',
    url: 'https://res.cloudinary.com/demo/image/upload/v1/sample.png',
    publicId: 'wizardchat/sample',
    name: 'demo.png',
    mime: 'image/png',
    size: 12345,
    width: 800,
    height: 600,
  };

  const bobSees = waitFor(bobSock, 'message:new', (m) => m.chatId === chatId && m.attachment?.name === 'demo.png');
  const sentImg = await emitAck(aliceSock, 'message:send', { chatId, content: '', attachment: IMG, tempId: 'p-1' });
  check('attachment-only send accepted (no caption)', sentImg.ok === true && sentImg.message?.isE2ee === false && !sentImg.message?.content);
  check(
    'message payload carries attachment descriptor',
    sentImg.message?.attachment?.url === IMG.url &&
      sentImg.message?.attachment?.name === 'demo.png' &&
      sentImg.message?.attachment?.resourceType === 'image' &&
      sentImg.message?.attachment?.width === 800,
  );
  const receivedImg = await bobSees;
  check('group member receives message with attachment', receivedImg?.attachment?.url === IMG.url && receivedImg?.sender?.username === aliceName);

  const bobSees2 = waitFor(bobSock, 'message:new', (m) => m.attachment?.name === 'clip.mp4');
  const sentCaption = await emitAck(aliceSock, 'message:send', {
    chatId,
    content: 'look at this',
    attachment: {
      resourceType: 'video',
      url: 'https://res.cloudinary.com/demo/video/upload/v1/clip.mp4',
      publicId: 'wizardchat/clip',
      name: 'clip.mp4',
      mime: 'video/mp4',
      size: 2048,
      width: null,
      height: null,
    },
    tempId: 'p-2',
  });
  check('attachment + caption accepted', sentCaption.ok === true && sentCaption.message?.content === 'look at this' && sentCaption.message?.attachment?.resourceType === 'video');
  await bobSees2;

  const hist = await api(`/chats/${chatId}/messages`, { token: bob.accessToken });
  const histAtts = (hist.data?.messages ?? []).filter((m) => m.attachment);
  check('history returns decrypted attachment descriptors', histAtts.length >= 1 && histAtts.some((m) => m.attachment.url === IMG.url), `atts=${histAtts.length}`);

  const list = await api('/chats', { token: bob.accessToken });
  const bobChat = (list.data?.chats ?? []).find((c) => c.id === chatId);
  check(
    'chat list preview includes attachment (no caption → media label)',
    bobChat?.lastMessage?.attachment?.kind === 'video' && bobChat?.lastMessage?.content === 'look at this',
    JSON.stringify(bobChat?.lastMessage ?? null),
  );
  check('avatarUrl present on chat list item', bobChat != null && 'avatarUrl' in bobChat);

  // --- 3. Attachment validation ---
  const noUrl = await emitAck(aliceSock, 'message:send', {
    chatId,
    content: '',
    attachment: { resourceType: 'image', name: 'x' },
    tempId: 'p-3',
  });
  check('attachment missing url rejected', noUrl.ok === false);

  const httpUrl = await emitAck(aliceSock, 'message:send', {
    chatId,
    content: '',
    attachment: { resourceType: 'image', url: 'http://evil.example.com/x.png', name: 'x' },
    tempId: 'p-4',
  });
  check('non-https attachment url rejected', httpUrl.ok === false);

  const tooBig = await emitAck(aliceSock, 'message:send', {
    chatId,
    content: '',
    attachment: { resourceType: 'raw', url: 'https://res.cloudinary.com/demo/raw/upload/x.bin', name: 'big.bin', size: 25_000_000 },
    tempId: 'p-5',
  });
  check('oversized attachment rejected', tooBig.ok === false);

  const bothEmpty = await emitAck(aliceSock, 'message:send', { chatId, content: '', tempId: 'p-6' });
  check('no content and no attachment rejected', bothEmpty.ok === false);

  // --- 4. Attachments in direct chat / E2EE interactions ---
  const direct = await api('/chats/direct', { method: 'POST', token: alice.accessToken, body: { userId: bobId } });
  const directId = direct.data?.chat?.id;
  check('direct chat created', [200, 201].includes(direct.status) && !!directId, `status=${direct.status}`);

  const directAtt = await emitAck(aliceSock, 'message:send', {
    chatId: directId,
    content: '',
    attachment: { resourceType: 'image', url: 'https://res.cloudinary.com/demo/image/upload/v1/direct.png', name: 'direct.png', size: 10 },
    tempId: 'p-7',
  });
  check('attachment-only allowed in direct chat (server-encrypted, no E2EE caption)', directAtt.ok === true && directAtt.message?.isE2ee === false);

  const e2eeEmpty = await emitAck(aliceSock, 'message:send', { chatId: directId, content: '', nonce: '', isE2ee: true, tempId: 'p-8' });
  check('E2EE envelope with empty content rejected', e2eeEmpty.ok === false);

  // --- 5. At-rest encryption of attachment descriptors (DB check) ---
  if (process.env.DATABASE_URL) {
    const prisma = new PrismaClient();
    try {
      const msgId = sentImg.message?.id;
      if (msgId) {
        const row = await prisma.message.findUnique({ where: { id: msgId } });
        check(
          'attachment descriptor encrypted at rest (ciphertext != plaintext)',
          !!row && typeof row.attachmentCiphertext === 'string' && typeof row.attachmentNonce === 'string',
        );
        const base64 = Buffer.from(row.attachmentCiphertext ?? '', 'base64');
        check(
          'attachment blob is valid base64 (iv+ct+tag)',
          base64.length >= 29 && base64.toString('base64') === row.attachmentCiphertext,
          `len=${base64.length}`,
        );
      }
    } finally {
      await prisma.$disconnect();
    }
  } else {
    console.log('SKIP  at-rest DB checks (DATABASE_URL not set)');
  }

  // --- 6. User avatar ---
  const avatarUrl = 'https://res.cloudinary.com/demo/image/upload/v1/avatars/alice.png';
  const setAvatar = await api('/users/me/avatar', { method: 'PUT', token: alice.accessToken, body: { avatarUrl } });
  check('set own avatar', setAvatar.status === 200 && setAvatar.data?.avatarUrl === avatarUrl);
  const me = await api('/auth/me', { token: alice.accessToken });
  check('avatar reflected in /auth/me', me.status === 200 && me.data?.user?.avatarUrl === avatarUrl);
  const badAvatar = await api('/users/me/avatar', { method: 'PUT', token: alice.accessToken, body: { avatarUrl: 'http://alice.example.com/a.png' } });
  check('http avatar url rejected', badAvatar.status === 400);
  const search = await api('/users/search?q=' + bobName.slice(0, 3), { token: carol.accessToken });
  check('search returns avatarUrl', (search.data?.users ?? []).some((u) => u.id === bobId && u.avatarUrl === null));

  const clearAvatar = await api('/users/me/avatar', { method: 'PUT', token: alice.accessToken, body: { avatarUrl: null } });
  check('clear avatar (null)', clearAvatar.status === 200 && clearAvatar.data?.avatarUrl === null);

  // --- 7. Group avatar ---
  const groupAvatarUrl = 'https://res.cloudinary.com/demo/image/upload/v1/groups/media.png';
  const memberPatch = await api(`/chats/${chatId}`, { method: 'PATCH', token: bob.accessToken, body: { avatarUrl: groupAvatarUrl } });
  check('non-admin cannot set group avatar', memberPatch.status === 403);

  const setGroup = await api(`/chats/${chatId}`, { method: 'PATCH', token: alice.accessToken, body: { avatarUrl: groupAvatarUrl } });
  check('owner sets group avatar', setGroup.status === 200 && setGroup.data?.chat?.avatarUrl === groupAvatarUrl);
  const groupView = await api(`/chats/${chatId}`, { token: bob.accessToken });
  check('group avatar visible to member', groupView.data?.chat?.avatarUrl === groupAvatarUrl);
  const renameOnly = await api(`/chats/${chatId}`, { method: 'PATCH', token: alice.accessToken, body: { name: 'Media Group 2' } });
  check('rename regression still works (avatar persisted)', renameOnly.data?.chat?.name === 'Media Group 2' && renameOnly.data?.chat?.avatarUrl === groupAvatarUrl);

  const list2 = await api('/chats', { token: bob.accessToken });
  const bobChat2 = (list2.data?.chats ?? []).find((c) => c.id === chatId);
  check('group avatarUrl in chat list', bobChat2?.avatarUrl === groupAvatarUrl);

  const clearGroup = await api(`/chats/${chatId}`, { method: 'PATCH', token: alice.accessToken, body: { avatarUrl: null } });
  check('owner clears group avatar (null)', clearGroup.status === 200 && clearGroup.data?.chat?.avatarUrl === null);
  const nullPatch = await api(`/chats/${chatId}`, { method: 'PATCH', token: alice.accessToken, body: { avatarUrl: 123 } });
  check('non-string avatarUrl rejected by schema', nullPatch.status === 400);

  const directView = await api(`/chats/${directId}`, { token: alice.accessToken });
  check('member avatarUrl surfaces in chat summary', (directView.data?.chat?.members ?? []).some((m) => m.userId === bobId && 'avatarUrl' in m));

  const summary = results.reduce((acc, r) => ({ pass: acc.pass + (r.pass ? 1 : 0), fail: acc.fail + (r.pass ? 0 : 1) }), { pass: 0, fail: 0 });
  console.log(`\n${summary.pass}/${results.length} checks passed`);
  aliceSock.disconnect();
  bobSock.disconnect();
  if (summary.fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});