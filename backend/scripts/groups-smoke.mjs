/* Group chats smoke test.
 * Requires API + Postgres:  API_URL=http://localhost:3111 node scripts/groups-smoke.mjs
 */
/* eslint-disable no-console */
import { io } from 'socket.io-client';

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

function receive(socket, event, callback) {
  socket.on(event, callback);
}

async function main() {
  const rand = Math.random().toString(36).slice(2, 8);
  const ownerName = `galice_${rand}`;
  const memberName = `gbob_${rand}`;
  const member2Name = `gcarol_${rand}`;
  const outsiderName = `gdan_${rand}`;

  const reg = async (name) => {
    const r = await api('/auth/register', {
      method: 'POST',
      body: { username: name, email: `${name}@test.local`, password: 'Password123!' },
    });
    if (r.status !== 201) throw new Error(`register ${name} failed: ${r.status}`);
    return r.data;
  };

  const owner = await reg(ownerName);
  const member = await reg(memberName);
  const member2 = await reg(member2Name);
  const outsider = await reg(outsiderName);
  const ownerId = owner.user.id;
  const memberId = member.user.id;
  const member2Id = member2.user.id;
  const outsiderId = outsider.user.id;

  const [ownerSock, memberSock, member2Sock, outsiderSock] = await Promise.all([
    connect(owner.accessToken),
    connect(member.accessToken),
    connect(member2.accessToken),
    connect(outsider.accessToken),
  ]);

  // --- Create group ---
  const memberChatNew = waitFor(memberSock, 'chat:new', (p) => p.chat?.type === 'GROUP');
  const member2ChatNew = waitFor(member2Sock, 'chat:new', (p) => p.chat?.type === 'GROUP');
  let ownerChatNewCount = 0;
  receive(ownerSock, 'chat:new', () => {
    ownerChatNewCount += 1;
  });

  const createRes = await api('/chats/groups', {
    method: 'POST',
    token: owner.accessToken,
    body: { name: 'Group A', userIds: [memberId, member2Id] },
  });
  check('owner creates group', createRes.status === 201 && createRes.data?.chat?.type === 'GROUP', `status=${createRes.status}`);
  const chat = createRes.data.chat;
  const chatId = chat.id;
  check('creator is owner, myRole=owner', chat.myRole === 'owner');
  check(
    'members carry roles',
    chat.members.some((m) => m.userId === ownerId && m.role === 'owner') &&
      chat.members.filter((m) => m.role === 'member').length === 2,
    JSON.stringify(chat.members.map((m) => `${m.username}:${m.role}`)),
  );
  const addedForMember = await memberChatNew;
  const addedForMember2 = await member2ChatNew;
  check('both members receive chat:new realtime', addedForMember?.chat?.id === chatId && addedForMember2?.chat?.id === chatId);
  check('creator is not notified of their own create', ownerChatNewCount === 0);

  // --- Per-member view ---
  const memberView = await api(`/chats/${chatId}`, { token: member.accessToken });
  check('member GET /chats/:id shows member role', memberView.status === 200 && memberView.data?.chat?.myRole === 'member');

  // --- Subscribe + message ---
  for (const [sock, name] of [[ownerSock, 'owner'], [memberSock, 'member'], [member2Sock, 'member2']]) {
    const sub = await emitAck(sock, 'chat:subscribe', { chatId });
    check(
      `${name} subscribes to group`,
      sub.ok === true && Array.isArray(sub.members) && sub.members.every((m) => m.userId === ownerId || m.userId === memberId || m.userId === member2Id),
      `ok=${sub.ok}`,
    );
  }

  const membersSee = Promise.all([
    waitFor(memberSock, 'message:new', (m) => m.chatId === chatId),
    waitFor(member2Sock, 'message:new', (m) => m.chatId === chatId),
  ]);
  const sent = await emitAck(ownerSock, 'message:send', { chatId, content: 'hello group', tempId: 'g-1' });
  check('group message ack ok, server-encrypted', sent.ok === true && sent.message?.isE2ee === false && sent.message?.content === 'hello group');
  const [m1, m2] = await membersSee;
  check('both members receive group message', m1.content === 'hello group' && m2.content === 'hello group');
  check('message payload carries sender username', m1.sender?.username === ownerName);

  // Non-member cannot subscribe/send/read
  const outsiderSub = await emitAck(outsiderSock, 'chat:subscribe', { chatId });
  check('non-member subscribe rejected', outsiderSub.ok === false);
  const outsiderMsg = await emitAck(outsiderSock, 'message:send', { chatId, content: 'sneak in', tempId: 'x-1' });
  const outsiderMsgs = await api(`/chats/${chatId}/messages`, { token: outsider.accessToken });
  check('non-member cannot send/read', outsiderMsg.ok === false && outsiderMsgs.status === 404);

  // --- Permissions ---
  const memberAdds = await api(`/chats/${chatId}/members`, {
    method: 'POST',
    token: member.accessToken,
    body: { userIds: [outsiderId] },
  });
  check('member cannot add users', memberAdds.status === 403);

  const outsiderChatNew = waitFor(outsiderSock, 'chat:new', () => true);
  const ownerAdds = await api(`/chats/${chatId}/members`, {
    method: 'POST',
    token: owner.accessToken,
    body: { userIds: [outsiderId] },
  });
  check('owner adds outsider', ownerAdds.status === 200 && ownerAdds.data.members.some((m) => m.userId === outsiderId));
  const added = await outsiderChatNew;
  check('added user receives chat:new with summary', added?.chat?.id === chatId && added?.chat?.myRole === 'member');
  void outsiderChatNew;

  const duplicateAdd = await api(`/chats/${chatId}/members`, {
    method: 'POST',
    token: owner.accessToken,
    body: { userIds: [outsiderId] },
  });
  check('duplicate add rejected (409)', duplicateAdd.status === 409);

  const outsiderSub2 = await emitAck(outsiderSock, 'chat:subscribe', { chatId });
  check('added outsider can now subscribe', outsiderSub2.ok === true);
  const outsiderHist = await api(`/chats/${chatId}/messages`, { token: outsider.accessToken });
  check('added outsider sees group history', outsiderHist.status === 200 && outsiderHist.data.messages.some((m) => m.content === 'hello group'));

  const memberRemoves = await api(`/chats/${chatId}/members/${member2Id}`, {
    method: 'DELETE',
    token: member.accessToken,
  });
  check('member cannot remove others', memberRemoves.status === 403);

  // --- Promote to admin ---
  const promote = await api(`/chats/${chatId}/members/${memberId}/role`, {
    method: 'PATCH',
    token: owner.accessToken,
    body: { role: 'admin' },
  });
  check('owner promotes member to admin', promote.status === 200 && promote.data.members.find((m) => m.userId === memberId)?.role === 'admin');
  const memberView2 = await api(`/chats/${chatId}`, { token: member.accessToken });
  check('promoted member sees own role admin', memberView2.data?.chat?.myRole === 'admin');

  const adminTriesDemote = await api(`/chats/${chatId}/members/${member2Id}/role`, {
    method: 'PATCH',
    token: member.accessToken,
    body: { role: 'member' },
  });
  check('admin cannot change roles (owner-only)', adminTriesDemote.status === 403);

  // --- Admin removes member2 ---
  const adminShares = waitFor(memberSock, 'chat:members', (p) => p.chatId === chatId && !p.members.some((m) => m.userId === member2Id));
  const member2Removed = waitFor(member2Sock, 'chat:removed', (p) => p.chatId === chatId);
  const adminRemoves = await api(`/chats/${chatId}/members/${member2Id}`, {
    method: 'DELETE',
    token: member.accessToken,
  });
  check('admin removes a member', adminRemoves.status === 200 && adminRemoves.data?.deleted === false);
  const shared = await adminShares;
  check('chat:members broadcast excludes removed', shared?.chatId === chatId && !shared.members.some((m) => m.userId === member2Id), JSON.stringify(shared?.members?.map((m) => `${m.username}:${m.role}`)));
  const removedEvt = await member2Removed;
  check('removed member receives chat:removed', removedEvt?.chatId === chatId);
  const removedHist = await api(`/chats/${chatId}/messages`, { token: member2.accessToken });
  const removedMsg = await emitAck(member2Sock, 'message:send', { chatId, content: 'still here?', tempId: 'y-1' });
  check('removed member loses access', removedHist.status === 404 && removedMsg.ok === false);

  // --- Re-add + rename ---
  const readd = await api(`/chats/${chatId}/members`, {
    method: 'POST',
    token: owner.accessToken,
    body: { userIds: [member2Id] },
  });
  check('owner re-adds removed member', readd.status === 200);

  const rename = await api(`/chats/${chatId}`, {
    method: 'PATCH',
    token: owner.accessToken,
    body: { name: 'Group Beta' },
  });
  check('owner renames group', rename.status === 200 && rename.data.chat?.name === 'Group Beta');
  const renamedView = await api(`/chats/${chatId}`, { token: member.accessToken });
  check('rename visible to members', renamedView.data?.chat?.name === 'Group Beta');

  // --- Owner protection + leaving ---
  const ownerTargeted = await api(`/chats/${chatId}/members/${ownerId}`, {
    method: 'DELETE',
    token: member.accessToken,
  });
  check('owner cannot be removed', ownerTargeted.status === 403);

  const outsiderLeaves = await api(`/chats/${chatId}/leave`, {
    method: 'POST',
    token: outsider.accessToken,
  });
  check('member can leave group', outsiderLeaves.status === 200 && outsiderLeaves.data?.deleted === false);
  const outsiderViewAfter = await api(`/chats/${chatId}`, { token: outsider.accessToken });
  check('leaver loses access', outsiderViewAfter.status === 404);
  const outsiderList = await api('/chats', { token: outsider.accessToken });
  check('leaver group gone from chat list', !(outsiderList.data?.chats ?? []).some((c) => c.id === chatId));

  // Owner leaves → ownership transfers to earliest-joined remaining member
  const ownerLeaves = await api(`/chats/${chatId}/leave`, {
    method: 'POST',
    token: owner.accessToken,
  });
  check('owner can leave (transfers ownership)', ownerLeaves.status === 200 && ownerLeaves.data?.deleted === false);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const ownerViewAfter = await api(`/chats/${chatId}`, { token: owner.accessToken });
  check('ex-owner loses access', ownerViewAfter.status === 404);
  const memberView3 = await api(`/chats/${chatId}`, { token: member.accessToken });
  check('ownership transferred to remaining member', memberView3.status === 200 && memberView3.data?.chat?.myRole === 'owner', `myRole=${memberView3.data?.chat?.myRole}`);

  const summary = results.reduce((acc, r) => ({ pass: acc.pass + (r.pass ? 1 : 0), fail: acc.fail + (r.pass ? 0 : 1) }), { pass: 0, fail: 0 });
  console.log(`\n${summary.pass}/${results.length} checks passed`);
  for (const s of [ownerSock, memberSock, member2Sock, outsiderSock]) s.disconnect();
  if (summary.fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});