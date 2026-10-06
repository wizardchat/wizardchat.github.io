/* Admin panel smoke: user list/search, ban/unban, role changes, per-user
 * message listing + deletion, password reset, and account deletion (with
 * chat cascade). Requires API + Postgres:
 *   API_URL=http://localhost:3111 node scripts/admin-smoke.mjs
 * The script self-promotes one of the registered users to ADMIN via Prisma.
 */
/* eslint-disable no-console */
import { io } from 'socket.io-client';
import { PrismaClient } from '@prisma/client';

const API = process.env.API_URL ?? 'http://localhost:3111';
const prisma = new PrismaClient();
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

async function registerSample(name) {
  const res = await api('/auth/register', {
    method: 'POST',
    body: { username: name, email: `${name}@test.local`, password: 'Password123!' },
  });
  return { status: res.status, ...res.data };
}

async function main() {
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffff).toString(36)}`;
  const adminName = `adm_${suffix}`;
  const targetName = `tgt_${suffix}`;
  const otherName = `oth_${suffix}`;

  const adminReg = await registerSample(adminName);
  const targetReg = await registerSample(targetName);
  const otherReg = await registerSample(otherName);
  check('three test users registered', adminReg.status === 201 && targetReg.status === 201 && otherReg.status === 201);

  const adminId = adminReg.user.id;
  const targetId = targetReg.user.id;
  const otherId = otherReg.user.id;

  await prisma.user.update({ where: { username: adminName }, data: { role: 'ADMIN' } });

  const forbidden = await api('/admin/users', { token: targetReg.accessToken });
  check('non-admin gets 403 on /admin/users', forbidden.status === 403);

  const firstList = await api('/admin/users', { token: adminReg.accessToken });
  const foundAll = (firstList.data?.users ?? []).some((u) => u.id === adminId)
    && firstList.data?.users.some((u) => u.id === targetId)
    && firstList.data?.users.some((u) => u.id === otherId);
  check('admin lists users + total', firstList.status === 200 && foundAll && firstList.data.total >= 3);
  const targetEntry = firstList.data?.users.find((u) => u.id === targetId);
  check('list includes messageCount + activeSessions', typeof targetEntry?.messageCount === 'number' && typeof targetEntry?.activeSessions === 'number');

  const search = await api(`/admin/users?q=${encodeURIComponent(targetName.slice(0, 5))}`, { token: adminReg.accessToken });
  check('search by username prefix', search.status === 200 && search.data.users.some((u) => u.id === targetId));

  const ban = await api(`/admin/users/${targetId}`, { method: 'PATCH', token: adminReg.accessToken, body: { banned: true } });
  check('admin bans user', ban.status === 200 && ban.data.user.banned === true);
  const bannedMe = await api('/auth/me', { token: targetReg.accessToken });
  check('banned user is blocked at auth (403)', bannedMe.status === 403);
  const unban = await api(`/admin/users/${targetId}`, { method: 'PATCH', token: adminReg.accessToken, body: { banned: false } });
  check('admin unblocks user', unban.status === 200 && unban.data.user.banned === false);
  const unbannedMe = await api('/auth/me', { token: targetReg.accessToken });
  check('unbanned user can call API again', unbannedMe.status === 200);

  const selfBan = await api(`/admin/users/${adminId}`, { method: 'PATCH', token: adminReg.accessToken, body: { banned: true } });
  check('cannot modify own account (ban)', selfBan.status === 400);
  const selfReset = await api(`/admin/users/${adminId}/reset-password`, { method: 'POST', token: adminReg.accessToken });
  check('cannot reset own password', selfReset.status === 400);
  const selfDelete = await api(`/admin/users/${adminId}`, { method: 'DELETE', token: adminReg.accessToken });
  check('cannot delete own account', selfDelete.status === 400);

  const promote = await api(`/admin/users/${targetId}`, { method: 'PATCH', token: adminReg.accessToken, body: { role: 'ADMIN' } });
  check('admin promotes user', promote.status === 200 && promote.data.user.role === 'ADMIN');
  const promotedList = await api('/admin/users', { token: targetReg.accessToken });
  check('promoted user can access admin API', promotedList.status === 200);
  const demote = await api(`/admin/users/${targetId}`, { method: 'PATCH', token: adminReg.accessToken, body: { role: 'USER' } });
  check('admin demotes user', demote.status === 200 && demote.data.user.role === 'USER');
  const demotedList = await api('/admin/users', { token: targetReg.accessToken });
  check('demoted user loses admin access', demotedList.status === 403);

  const invalidPatch = await api(`/admin/users/${targetId}`, { method: 'PATCH', token: adminReg.accessToken, body: { banned: 'yes' } });
  check('invalid PATCH body rejected', invalidPatch.status === 400);

  // Group chat so target can send server-side-encrypted plaintext messages.
  const group = await api('/chats/groups', {
    method: 'POST',
    token: targetReg.accessToken,
    body: { name: 'Admin Smoke', userIds: [otherId] },
  });
  const groupId = group.data?.chat?.id;
  const targetSock = await connect(targetReg.accessToken);
  const summary = group.data?.chat?.members?.find((m) => m.userId === targetId);
  check('group has target as owner?', summary?.role === 'owner');

  const hello = await emitAck(targetSock, 'message:send', { chatId: groupId, content: 'hello admin', tempId: 'a-1' });
  check('target sends message', hello.ok === true, hello.error ?? '');
  const messageId = hello.message?.id;

  const msgList = await api(`/admin/users/${targetId}/messages`, { token: adminReg.accessToken });
  check('admin sees user messages with preview', msgList.status === 200 && msgList.data.messages.some((m) => m.id === messageId && m.preview === 'hello admin'));

  const delOne = await api(`/admin/users/${targetId}/messages/${messageId}`, { method: 'DELETE', token: adminReg.accessToken });
  check('admin deletes a single message', delOne.status === 200 && delOne.data.ok === true);
  const afterDel = await api(`/chats/${groupId}/messages`, { token: targetReg.accessToken });
  check('deleted message gone for members', !(afterDel.data?.messages ?? []).some((m) => m.id === messageId));

  const second = await emitAck(targetSock, 'message:send', { chatId: groupId, content: 'second message', tempId: 'a-2' });
  const third = await emitAck(targetSock, 'message:send', { chatId: groupId, content: 'third message', tempId: 'a-3' });
  check('target sends two more messages', Boolean(second.message?.id && third.message?.id));

  const clear = await api(`/admin/users/${targetId}/messages`, { method: 'DELETE', token: adminReg.accessToken });
  check('admin clears all of user messages', clear.status === 200 && clear.data.deleted >= 2, `deleted=${clear.data?.deleted}`);
  const afterClear = await api(`/admin/users/${targetId}/messages`, { token: adminReg.accessToken });
  check('no messages remain after clear', afterClear.status === 200 && afterClear.data.messages.length === 0);

  const noMsgUser = await api(`/admin/users/${otherId}/messages`, { token: adminReg.accessToken });
  check('empty message list for user with no messages', noMsgUser.status === 200 && noMsgUser.data.messages.length === 0);
  const missingMsgUser = await api('/admin/users/doesnotexist/messages', { token: adminReg.accessToken });
  check('404 for nonexistent user messages', missingMsgUser.status === 404);

  const b64 = (n) => Buffer.alloc(n).toString('base64');
  const putKeys = await api('/users/me/e2e-key', {
    method: 'PUT',
    token: targetReg.accessToken,
    body: {
      publicKey: b64(32),
      wrappedKey: b64(32),
      kekSalt: b64(16),
      kekParams: JSON.stringify({ alg: 'PBKDF2', hash: 'SHA-256', iterations: 100000 }),
    },
  });
  check('target uploads E2EE keys', putKeys.status === 200);

  const reset = await api(`/admin/users/${targetId}/reset-password`, { method: 'POST', token: adminReg.accessToken });
  check('admin resets password, returns temp password', reset.status === 200 && typeof reset.data?.tempPassword === 'string' && reset.data.tempPassword.length >= 8);
  const e2eAfterReset = await api('/users/me/e2e-key', { token: targetReg.accessToken });
  check('reset cleared E2EE keys + wrapped key', e2eAfterReset.status === 200 && e2eAfterReset.data?.publicKey === null && e2eAfterReset.data?.wrappedKey === null);
  const resetLogin = await api('/auth/login', { method: 'POST', body: { identifier: targetName, password: reset.data.tempPassword } });
  check('login with temp password works', resetLogin.status === 200);
  const newToken = resetLogin.data?.accessToken;

  // Reset again so resetLogin token is dead, then delete the account.
  const deleteAcc = await api(`/admin/users/${targetId}`, { method: 'DELETE', token: adminReg.accessToken });
  check('admin deletes user account', deleteAcc.status === 200 && deleteAcc.data.deletedUser.username === targetName);
  const deletedMe = await api('/auth/me', { token: newToken });
  check('deleted user token invalid (401)', deletedMe.status === 401);
  const gone = await api(`/admin/users/${targetId}`, { token: adminReg.accessToken });
  check('deleted user no longer listed', gone.status === 404);
  const loginGone = await api('/auth/login', { method: 'POST', body: { identifier: targetName, password: reset.data.tempPassword } });
  check('deleted user cannot log in', loginGone.status !== 200, `status=${loginGone.status}`);

  // Deleting the group's other member leaves the group with 1 member (kept).
  // We own that group via Prisma cleanup below.

  const summaryToPrint = results.reduce((acc, r) => ({ pass: acc.pass + (r.pass ? 1 : 0), fail: acc.fail + (r.pass ? 0 : 1) }), { pass: 0, fail: 0 });
  console.log(`\n${summaryToPrint.pass}/${results.length} checks passed`);
  targetSock.disconnect();

  // Cleanup: remove remaining test data.
  await prisma.chat.deleteMany({ where: { id: groupId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { username: { in: [adminName, otherName] } } });

  await prisma.$disconnect();
  if (summaryToPrint.fail > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});