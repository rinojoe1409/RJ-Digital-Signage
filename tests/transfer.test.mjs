import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSignageServer } from '../server/server.mjs';
import { createPlayer } from '../player/agent.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/wlYAAAAASUVORK5CYII=', 'base64');
async function until(check, message, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error(message);
}
async function fixture(t, prefix) {
  const directory = path.join(root, 'tmp', prefix + randomUUID());
  const backend = await createSignageServer({ dataDir: path.join(directory, 'cms') });
  await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + backend.server.address().port;
  let cookie = '';
  t.after(async () => {
    backend.server.closeAllConnections(); await new Promise(resolve => backend.server.close(resolve));
    assert.ok(path.resolve(directory).startsWith(path.join(root, 'tmp') + path.sep));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  async function api(route, body, { method = body === undefined ? 'GET' : 'POST', token, headers = {} } = {}) {
    const response = await fetch(origin + route, { method,
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : cookie ? { Cookie: cookie } : {}), 'X-RJ-Request': '1',
        ...(body !== undefined && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    const value = await response.json(); assert.ok(response.ok, route + ': ' + (value.error || response.status));
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return value;
  }
  await api('/api/auth/setup', { username: 'qa-transfer', password: randomBytes(24).toString('hex') });
  const code = await api('/api/players/pair-code', {});
  const paired = await api('/api/player/pair', { code: code.code, name: 'PC Transfer Uji' });
  const layout = await api('/api/layouts', { name: 'Informasi Transfer', widgets: [{ id: 'message', type: 'text', text: 'Informasi baru' }] });
  const publish = async id => (await api('/api/layouts/' + (id || layout.id) + '/publish', { playerIds: [paired.id] })).publication;
  const player = async () => (await api('/api/state')).players.find(p => p.id === paired.id);
  const manifest = () => api('/api/player/manifest', undefined, { token: paired.token });
  const heartbeat = body => api('/api/player/heartbeat', body, { token: paired.token });
  return { directory, backend, origin, api, paired, layout, publish, player, manifest, heartbeat };
}

test('Transfer API: fresh generations govern completion, actual playback and stale/offline reports', { timeout: 20000 }, async t => {
  const f = await fixture(t, 'transfer-status-');
  let publication = await f.publish(), manifest = await f.manifest();
  await f.heartbeat({ status: 'playing', progress: 100, downloadedGeneration: 'older-generation', currentPublicationId: 'older-publication' });
  await t.test('old 100 percent cannot complete a newly published transfer', async () => {
    const p = await f.player();
    assert.equal(p.transfer.phase, 'pending'); assert.equal(p.transfer.progress, null); assert.equal(p.transfer.ready, false);
    assert.equal(p.transfer.expectedGeneration, manifest.generation); assert.equal(p.transfer.desiredPublicationId, publication.id);
    assert.equal(p.transfer.updatedAt, p.lastSeen);
    const serialized = JSON.stringify(await f.api('/api/state'));
    assert.doesNotMatch(serialized, /tokenHash/); assert.ok(!serialized.includes(f.paired.token));
  });
  await t.test('reported download is partial; hash/manifest completion is required for 100', async () => {
    await f.heartbeat({ status: 'downloading', progress: 37, downloadedGeneration: 'older-generation', currentPublicationId: null });
    assert.equal((await f.player()).transfer.phase, 'downloading'); assert.equal((await f.player()).transfer.progress, 37);
    await f.heartbeat({ status: 'downloading', progress: 100, downloadedGeneration: 'older-generation', currentPublicationId: null });
    assert.equal((await f.player()).transfer.progress, 99);
    await f.heartbeat({ status: 'ready', progress: 100, downloadedGeneration: manifest.generation, currentPublicationId: null });
    const p = await f.player(); assert.equal(p.transfer.phase, 'ready'); assert.equal(p.transfer.progress, 100); assert.equal(p.transfer.ready, true);
  });
  await t.test('downloaded content and screen activation are distinct acknowledgements', async () => {
    await f.heartbeat({ status: 'waiting-video', progress: 100, downloadedGeneration: manifest.generation, currentPublicationId: 'previous-publication' });
    assert.equal((await f.player()).transfer.phase, 'waiting-video');
    await f.heartbeat({ status: 'playing', progress: 100, downloadedGeneration: manifest.generation, currentPublicationId: publication.id, lastError: 'YouTube sementara tidak tersedia.' });
    assert.equal((await f.player()).transfer.phase, 'playing', 'A playback warning is not an incomplete file transfer');
    const oldGeneration = manifest.generation;
    publication = await f.publish(); manifest = await f.manifest();
    assert.notEqual(manifest.generation, oldGeneration);
    assert.equal((await f.player()).transfer.phase, 'pending'); assert.equal((await f.player()).transfer.progress, null);
    await f.heartbeat({ status: 'cached', progress: 62, downloadedGeneration: oldGeneration, currentPublicationId: 'previous-publication', lastError: 'Pemeriksaan media gagal.' });
    assert.equal((await f.player()).transfer.phase, 'error'); assert.equal((await f.player()).transfer.ready, false);
    assert.notEqual((await f.player()).transfer.progress, 100);
  });
  await t.test('future inventory changes invalidate transfer completion even when the current publication is unchanged', async () => {
    await f.heartbeat({ status: 'playing', progress: 100, downloadedGeneration: manifest.generation, currentPublicationId: publication.id, lastError: '' });
    const scheduled = await f.api('/api/layouts', { name: 'Program esok', widgets: [] });
    const start = Date.now() + 86400000;
    await f.api('/api/schedules', { name: 'Program esok', layoutId: scheduled.id, playerIds: [f.paired.id], enabled: true, repeat: 'once', startAt: new Date(start).toISOString(), endAt: new Date(start + 60000).toISOString() });
    const p = await f.player(); assert.equal(p.desiredPublicationId, publication.id);
    assert.equal(p.transfer.phase, 'pending'); assert.equal(p.transfer.ready, false); assert.equal(p.transfer.progress, null);
    manifest = await f.manifest();
  });
  await t.test('offline and revoked states never present a fresh success percentage', async () => {
    await f.heartbeat({ status: 'playing', progress: 100, downloadedGeneration: manifest.generation, currentPublicationId: publication.id });
    t.mock.timers.enable({ apis: ['Date'], now: new Date() });
    try {
      t.mock.timers.tick(71000);
      const p = await f.player(); assert.equal(p.online, false); assert.equal(p.transfer.phase, 'offline'); assert.equal(p.transfer.progress, null);
    } finally { t.mock.timers.reset(); }
    await f.api('/api/players/' + f.paired.id + '/action', { action: 'revoke' });
    const revoked = await f.player(); assert.equal(revoked.transfer.phase, 'revoked'); assert.equal(revoked.transfer.progress, null);
  });
});

test('Transfer from a real agent: partial network delivery, committed 100 and rejected corrupt media', { timeout: 45000 }, async t => {
  const f = await fixture(t, 'transfer-network-');
  let agent, corrupt = false;
  const pendingTimers = new Set();
  const proxy = http.createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const remote = await fetch(f.origin + req.url, { method: req.method,
        headers: { ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}), ...(req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {}) },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
      const bytes = Buffer.from(await remote.arrayBuffer());
      res.writeHead(remote.status, { 'Content-Type': remote.headers.get('content-type') || 'application/json' });
      if (!req.url.startsWith('/api/player/media/')) { res.end(bytes); return; }
      if (corrupt) bytes[bytes.length - 1] ^= 1;
      let offset = 0;
      const send = () => {
        if (res.destroyed) return;
        if (offset >= bytes.length) { res.end(); return; }
        res.write(bytes.subarray(offset, offset + 32768)); offset += 32768;
        const timer = setTimeout(() => { pendingTimers.delete(timer); send(); }, 1150); pendingTimers.add(timer);
      };
      send();
    } catch { if (!res.destroyed) { res.writeHead(502); res.end('{}'); } }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await agent?.close(); for (const timer of pendingTimers) clearTimeout(timer);
    proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
  });
  const upload = async name => f.api('/api/media', Buffer.concat([png, randomBytes(131072)]), { headers: { 'Content-Type': 'image/png', 'X-Filename': name } });
  const media = await upload('transfer-a.png');
  const layout = await f.api('/api/layouts', { name: 'Transfer nyata', widgets: [{ id: 'poster', type: 'image', mediaId: media.id }] });
  await f.publish(layout.id);
  const firstManifest = await f.manifest();
  agent = await createPlayer({ dataDir: path.join(f.directory, 'player'), port: 0, headless: true, connect: false,
    config: { id: f.paired.id, token: f.paired.token, serverUrl: 'http://127.0.0.1:' + proxy.address().port, name: 'PC Transfer Uji' } });
  const firstSync = agent.sync();
  await until(async () => { const p = await f.player(); return p.transfer.phase === 'downloading' && p.transfer.progress > 0 && p.transfer.progress < 100; }, 'CMS tidak menerima progres parsial dari agen nyata');
  assert.equal((await f.player()).transfer.ready, false);
  await firstSync;
  assert.equal((await f.player()).transfer.ready, true); assert.equal((await f.player()).transfer.progress, 100);
  assert.equal(agent.manifest.generation, firstManifest.generation);
  const nextMedia = await upload('transfer-b.png');
  await f.api('/api/layouts/' + layout.id, { ...layout, widgets: [{ id: 'poster', type: 'image', mediaId: nextMedia.id }] }, { method: 'PUT' });
  await f.publish(layout.id); corrupt = true;
  await agent.sync();
  const failed = await f.player(); assert.equal(failed.transfer.phase, 'error'); assert.equal(failed.transfer.ready, false); assert.notEqual(failed.transfer.progress, 100);
  assert.equal(agent.manifest.generation, firstManifest.generation, 'A failed hash must keep the last complete manifest');
});
