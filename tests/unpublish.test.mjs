import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSignageServer } from '../server/server.mjs';
import { createPlayer } from '../player/agent.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/wlYAAAAASUVORK5CYII=', 'base64');
const until = async (check, message, timeout = 6000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error(message);
};
const playerConfiguration = state => state.players.map(({ id, defaultPublicationId, manualOverride, history }) => ({ id, defaultPublicationId, manualOverride, history }));

test('Batalkan terbit: confirmation, references, real agent delivery, deletion and restore stay consistent', { timeout: 60000 }, async t => {
  const directory = path.join(root, 'tmp', 'unpublish-' + randomUUID());
  const serverDirectory = path.join(directory, 'server');
  const password = randomBytes(24).toString('hex');
  let backend, agent, origin, cookie = '', backendOpen = false;
  await fs.mkdir(directory, { recursive: true });
  async function start() {
    backend = await createSignageServer({ dataDir: serverDirectory });
    await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
    origin = 'http://127.0.0.1:' + backend.server.address().port; backendOpen = true;
  }
  async function stop() {
    if (!backendOpen) return;
    backend.server.closeAllConnections(); await new Promise(resolve => backend.server.close(resolve)); backendOpen = false;
  }
  t.after(async () => {
    await agent?.close(); await stop();
    assert.ok(path.resolve(directory).startsWith(path.join(root, 'tmp') + path.sep));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });
  await start();
  async function request(route, { method = 'GET', body, auth = true, token, headers = {} } = {}) {
    return fetch(origin + route, { method, headers: { 'X-RJ-Request': '1', ...(auth && cookie ? { Cookie: cookie } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body !== undefined && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
  }
  async function success(route, options) {
    const response = await request(route, options), value = await response.json();
    assert.ok(response.ok, route + ': ' + (value.error || response.status));
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return value;
  }
  const post = (route, body) => success(route, { method: 'POST', body });
  await post('/api/auth/setup', { username: 'qa-unpublish', password });
  const pair = async name => {
    const { code } = await post('/api/players/pair-code', {});
    return post('/api/player/pair', { code, name });
  };
  const p1 = await pair('QA player utama'), p2 = await pair('QA player lain');
  const media = await success('/api/media', { method: 'POST', body: png, headers: { 'Content-Type': 'image/png', 'X-Filename': 'unpublish-fallback.png' } });
  const layoutA = await post('/api/layouts', { name: 'QA layout akan dibatalkan', widgets: [{ id: 'poster-a', type: 'image', mediaId: media.id }] });
  const layoutB = await post('/api/layouts', { name: 'QA layout tidak terdampak', widgets: [{ id: 'text-b', type: 'text', text: 'Tetap tayang' }] });
  const publish = async (layout, playerIds) => (await post('/api/layouts/' + layout.id + '/publish', { playerIds })).publication;
  const pubA1 = await publish(layoutA, [p1.id, p2.id]);
  const pubB = await publish(layoutB, [p2.id]);
  const pubA2 = await publish(layoutA, [p1.id]);
  const future = { startAt: new Date(Date.now() + 86400000).toISOString(), endAt: new Date(Date.now() + 86460000).toISOString(), repeat: 'once', priority: 2 };
  const scheduleA = await post('/api/schedules', { ...future, name: 'QA jadwal A aktif', publicationId: pubA1.id, playerIds: [p1.id, p2.id], enabled: true });
  const scheduleAOff = await post('/api/schedules', { ...future, name: 'QA jadwal A nonaktif', publicationId: pubA2.id, playerIds: [p2.id], enabled: false });
  const scheduleB = await post('/api/schedules', { ...future, name: 'QA jadwal B', publicationId: pubB.id, playerIds: [p2.id], enabled: true });
  const route = '/api/layouts/' + layoutA.id + '/unpublish';
  const cancel = async impact => post(route, { confirm: 'BATALKAN TERBIT', impactToken: impact.impactToken });
  let pubA3, withdrawnAtById;

  await t.test('authentication, cross-origin and explicit confirmation protect the operation', async () => {
    const impact = await success(route);
    assert.equal(impact.publicationCount, 2);
    assert.deepEqual(new Set(impact.players.map(p => p.id)), new Set([p1.id, p2.id]));
    assert.equal(impact.players.find(p => p.id === p1.id).assigned, true);
    assert.equal(impact.players.find(p => p.id === p2.id).scheduled, true);
    assert.deepEqual(new Set(impact.schedules.map(s => s.id)), new Set([scheduleA.id, scheduleAOff.id]));
    assert.equal((await request(route, { auth: false })).status, 401);
    const body = { confirm: 'BATALKAN TERBIT', impactToken: impact.impactToken };
    assert.equal((await request(route, { method: 'POST', auth: false, body })).status, 401);
    assert.equal((await request(route, { method: 'POST', body, headers: { Origin: 'https://external.invalid' } })).status, 403);
    assert.equal((await request(route, { method: 'POST', body, headers: { 'X-RJ-Request': '' } })).status, 403);
    assert.equal((await request(route, { method: 'POST', body: { impactToken: impact.impactToken } })).status, 400);
    assert.equal((await request(route, { method: 'POST', body: { confirm: 'BATALKAN TERBIT' } })).status, 409);
    assert.equal((await request('/api/layouts/' + layoutA.id, { method: 'DELETE' })).status, 409);
    assert.equal((await success('/api/state')).publications.some(p => p.withdrawnAt), false);
  });

  await t.test('a publish while confirmation is open invalidates the token without partial withdrawal', async () => {
    const impact = await success(route);
    pubA3 = await publish(layoutA, []);
    const before = await success('/api/state');
    assert.equal((await request(route, { method: 'POST', body: { confirm: 'BATALKAN TERBIT', impactToken: impact.impactToken } })).status, 409);
    const after = await success('/api/state');
    assert.deepEqual(after.publications, before.publications);
    assert.deepEqual(after.schedules, before.schedules);
    assert.deepEqual(playerConfiguration(after), playerConfiguration(before));
  });

  await t.test('heartbeat does not invalidate confirmation; withdrawal reaches the real agent through SSE', async () => {
    agent = await createPlayer({ dataDir: path.join(directory, 'player'), port: 0, headless: true, config: { id: p1.id, token: p1.token, serverUrl: origin, name: 'QA player utama' } });
    await until(() => agent.manifest?.programs.some(p => p.id === pubA2.id), 'Agent belum menerima layout A');
    const acknowledged = await fetch(agent.address + '/api/local/status', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-RJ-Request': '1' },
      body: JSON.stringify({ status: 'playing', currentPublicationId: pubA2.id, lastError: '' }) });
    assert.equal(acknowledged.status, 200); await acknowledged.arrayBuffer();
    await agent.sync();
    const impact = await success(route);
    await success('/api/player/heartbeat', { method: 'POST', auth: false, token: p2.token, body: { status: 'playing', progress: 100, currentPublicationId: pubB.id, downloadedGeneration: 'heartbeat-only', lastError: '', screen: { width: 1920, height: 1080 } } });
    assert.equal((await success(route)).impactToken, impact.impactToken, 'Heartbeat must not invalidate a stable configuration');
    const before = await success('/api/state');
    await cancel(impact);
    // No explicit sync here. The 60-second fallback poll cannot satisfy this deadline.
    await until(() => agent.manifest?.programs.every(p => p.layoutId !== layoutA.id) && agent.manifest?.defaultPublicationId === null, 'SSE tidak mengirim pembatalan kepada agent', 6000);
    const after = await success('/api/state');
    const player1 = after.players.find(p => p.id === p1.id), player2 = after.players.find(p => p.id === p2.id);
    assert.equal(player1.defaultPublicationId, null); assert.equal(player1.manualOverride, null);
    assert.deepEqual(player1.history, []);
    assert.equal(player1.currentPublicationId, pubA2.id, 'Server must retain actual playback telemetry until renderer acknowledges the change');
    assert.equal(player2.defaultPublicationId, pubB.id); assert.equal(player2.manualOverride.publicationId, pubB.id);
    assert.deepEqual(player2.history, []);
    assert.deepEqual(after.publications.find(p => p.id === pubB.id), before.publications.find(p => p.id === pubB.id));
    assert.deepEqual(after.schedules.find(s => s.id === scheduleB.id), before.schedules.find(s => s.id === scheduleB.id));
    assert.ok(after.publications.filter(p => p.layoutId === layoutA.id).every(p => Number.isFinite(Date.parse(p.withdrawnAt))));
    withdrawnAtById = new Map(after.publications.filter(p => p.layoutId === layoutA.id).map(p => [p.id, p.withdrawnAt]));
    for (const original of [scheduleA, scheduleAOff]) {
      const saved = after.schedules.find(s => s.id === original.id);
      assert.equal(saved.enabled, false);
      for (const key of ['name', 'startAt', 'endAt', 'repeat', 'priority', 'publicationId']) assert.deepEqual(saved[key], original[key]);
      assert.deepEqual(saved.playerIds, original.playerIds);
    }
    assert.deepEqual(after.layouts.find(l => l.id === layoutA.id), layoutA, 'Draft content must remain unchanged');
    assert.deepEqual(Buffer.from(await (await request('/api/media/' + media.id + '/file')).arrayBuffer()), png);
    const secondManifest = await success('/api/player/manifest', { auth: false, token: p2.token });
    assert.ok(secondManifest.programs.some(p => p.id === pubB.id));
    assert.equal(secondManifest.programs.some(p => p.layoutId === layoutA.id), false);
    assert.equal((await success(route)).publicationCount, 0);
  });

  await t.test('withdrawn versions cannot be re-enabled or restored as an active reference', async () => {
    assert.equal((await request('/api/schedules/' + scheduleA.id, { method: 'PUT', body: { ...scheduleA, enabled: true } })).status, 400);
    const backup = await success('/api/backup');
    for (const change of [
      archive => { archive.state.players.find(p => p.id === p1.id).defaultPublicationId = pubA2.id; },
      archive => { archive.state.players.find(p => p.id === p1.id).manualOverride = { publicationId: pubA2.id, since: new Date().toISOString() }; },
      archive => { archive.state.schedules.find(s => s.id === scheduleA.id).enabled = true; },
      archive => { archive.state.publications.find(p => p.id === pubA2.id).withdrawnAt = 'not-a-date'; },
    ]) {
      const broken = structuredClone(backup); change(broken);
      assert.equal((await request('/api/restore', { method: 'POST', body: { ...broken, confirm: 'PULIHKAN' } })).status, 400);
    }
    await post('/api/restore', { ...backup, confirm: 'PULIHKAN' });
    const restored = await success('/api/state');
    for (const [id, at] of withdrawnAtById) assert.equal(restored.publications.find(p => p.id === id).withdrawnAt, at);
    assert.equal(restored.schedules.find(s => s.id === scheduleA.id).enabled, false);
  });

  await t.test('republish creates a new revision and rollback cannot revive a withdrawn version', async () => {
    const republished = await publish(layoutA, [p1.id]);
    assert.equal(republished.revision, pubA3.revision + 1);
    assert.equal(republished.withdrawnAt, undefined);
    assert.equal((await request('/api/players/' + p1.id + '/action', { method: 'POST', body: { action: 'rollback' } })).status, 409);
    const current = await success('/api/state');
    assert.equal(current.players.find(p => p.id === p1.id).defaultPublicationId, republished.id);
    for (const [id, at] of withdrawnAtById) assert.equal(current.publications.find(p => p.id === id).withdrawnAt, at);
    assert.equal((await request('/api/layouts/' + layoutA.id, { method: 'DELETE' })).status, 409);
    await cancel(await success(route));
  });

  await t.test('the draft can be deleted while disabled schedule details and archived media remain protected', async () => {
    await success('/api/layouts/' + layoutA.id, { method: 'DELETE' });
    const after = await success('/api/state');
    assert.equal(after.layouts.some(l => l.id === layoutA.id), false);
    assert.ok(after.publications.filter(p => p.layoutId === layoutA.id).every(p => p.withdrawnAt));
    assert.equal(after.schedules.find(s => s.id === scheduleA.id).name, scheduleA.name);
    assert.equal(after.schedules.find(s => s.id === scheduleA.id).enabled, false);
    assert.equal((await request('/api/media/' + media.id, { method: 'DELETE' })).status, 409, 'Retained publication snapshots must keep their media');
    const backup = await success('/api/backup');
    await post('/api/layouts', { name: 'QA temporary after backup', widgets: [] });
    await post('/api/restore', { ...backup, confirm: 'PULIHKAN' });
    const restored = await success('/api/state');
    assert.equal(restored.layouts.some(l => l.id === layoutA.id), false);
    assert.equal(restored.layouts.some(l => l.name === 'QA temporary after backup'), false);
    assert.deepEqual(new Map(restored.publications.filter(p => p.layoutId === layoutA.id).map(p => [p.id, p.withdrawnAt])),
      new Map(backup.state.publications.filter(p => p.layoutId === layoutA.id).map(p => [p.id, p.withdrawnAt])));
  });

  await t.test('restart preserves withdrawal, disabled schedules, deleted draft and existing player credentials', async () => {
    await agent.close(); agent = null;
    const before = await success('/api/state');
    await stop(); await start(); cookie = '';
    await post('/api/auth/login', { username: 'qa-unpublish', password });
    const after = await success('/api/state');
    assert.deepEqual(after.layouts, before.layouts);
    assert.deepEqual(after.publications, before.publications);
    assert.deepEqual(after.schedules, before.schedules);
    assert.deepEqual(playerConfiguration(after), playerConfiguration(before));
    const manifest = await success('/api/player/manifest', { auth: false, token: p1.token });
    assert.equal(manifest.defaultPublicationId, null);
    assert.equal(manifest.programs.some(p => p.layoutId === layoutA.id), false);
    assert.equal(manifest.schedules.some(s => s.publicationId === pubA1.id || s.publicationId === pubA2.id), false);
  });
});
