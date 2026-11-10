import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSignageServer } from '../server/server.mjs';
import { createPlayer } from '../player/agent.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/wlYAAAAASUVORK5CYII=', 'base64');

test('Playlist video API: order, duplicates, clip mute, validation, immutable publish, cache and backup', { timeout: 60000 }, async t => {
  const directory = path.join(root, 'tmp', 'playlist-api-' + randomUUID());
  let backend, agent, cookie = '', backendOpen = false;
  await fs.mkdir(directory, { recursive: true });
  backend = await createSignageServer({ dataDir: path.join(directory, 'cms') });
  await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve)); backendOpen = true;
  const origin = 'http://127.0.0.1:' + backend.server.address().port;
  t.after(async () => {
    await agent?.close();
    if (backendOpen) { backend.server.closeAllConnections(); await new Promise(resolve => backend.server.close(resolve)); }
    assert.ok(path.resolve(directory).startsWith(path.join(root, 'tmp') + path.sep));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });
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
  await post('/api/auth/setup', { username: 'qa-playlist', password: randomBytes(24).toString('hex') });
  const upload = (bytes, mime, name) => success('/api/media', { method: 'POST', body: bytes, headers: { 'Content-Type': mime, 'X-Filename': encodeURIComponent(name) } });
  // These fixtures prove API/cache integrity only; browser tests generate and decode real WebM clips.
  const bytesA = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
  const bytesB = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 8, 7, 6, 5]);
  const a = await upload(bytesA, 'video/webm', 'Klip A.webm'), b = await upload(bytesB, 'video/webm', 'Klip B.webm');
  const image = await upload(png, 'image/png', 'Poster.png');
  const widget = { id: 'ordered-clips', type: 'video', x: 0, y: 0, width: 1280, height: 720, muted: true, volume: 0.55,
    playlist: [{ mediaId: b.id, muted: false }, { mediaId: a.id, muted: true }, { mediaId: b.id }] };
  const draft = { name: 'Playlist <aman>', width: 1280, height: 720, widgets: [widget] };
  let layout, publication, paired;

  await t.test('ordered duplicate entries and individual mute survive saving while legacy entries keep inheritance', async () => {
    assert.equal((await request('/api/layouts', { method: 'POST', auth: false, body: draft })).status, 401);
    layout = await post('/api/layouts', draft);
    assert.deepEqual(layout.widgets[0].playlist, [{ mediaId: b.id, duration: 10, muted: false }, { mediaId: a.id, duration: 10, muted: true }, { mediaId: b.id, duration: 10 }]);
    assert.equal(layout.widgets[0].muted, true);
    assert.equal(layout.widgets[0].volume, 0.55);
    assert.deepEqual((await success('/api/state')).layouts.find(item => item.id === layout.id).widgets[0].playlist, layout.widgets[0].playlist);
  });
  await t.test('malformed, wrong-kind and non-boolean mute entries fail without changing the draft', async () => {
    for (const playlist of [null, 'invalid', [null], [{}], [{ mediaId: 'missing' }], [{ mediaId: image.id }], [{ mediaId: a.id, muted: 'false' }], [{ mediaId: a.id, muted: 0 }], Array.from({ length: 101 }, () => ({ mediaId: a.id }))]) {
      const response = await request('/api/layouts/' + layout.id, { method: 'PUT', body: { ...layout, widgets: [{ ...widget, playlist }] } });
      assert.equal(response.status, 400, 'Invalid playlist must produce a useful 400 response');
    }
    assert.deepEqual((await success('/api/state')).layouts.find(item => item.id === layout.id).widgets[0].playlist, layout.widgets[0].playlist);
  });
  await t.test('an empty draft can be saved but an enabled empty playlist cannot be published or scheduled', async () => {
    const empty = await post('/api/layouts', { name: 'Playlist belum diisi', widgets: [{ id: 'empty', type: 'video', playlist: [] }] });
    const before = await success('/api/state');
    assert.equal((await request('/api/layouts/' + empty.id + '/publish', { method: 'POST', body: { playerIds: [] } })).status, 400);
    const { code } = await post('/api/players/pair-code', {});
    paired = await post('/api/player/pair', { code, name: 'QA playlist player' });
    assert.equal((await request('/api/schedules', { method: 'POST', body: { name: 'Empty schedule', layoutId: empty.id, playerIds: [paired.id], startAt: new Date(Date.now() + 60000).toISOString(), endAt: new Date(Date.now() + 120000).toISOString(), enabled: true } })).status, 400);
    assert.equal((await success('/api/state')).publications.length, before.publications.length);
    const disabled = await success('/api/layouts/' + empty.id, { method: 'PUT', body: { ...empty, widgets: [{ ...empty.widgets[0], enabled: false }] } });
    assert.ok((await post('/api/layouts/' + disabled.id + '/publish', { playerIds: [] })).publication);
  });
  await t.test('publishing keeps clip settings immutable and downloads each distinct video once', async () => {
    publication = (await post('/api/layouts/' + layout.id + '/publish', { playerIds: [paired.id] })).publication;
    assert.deepEqual(publication.layout.widgets[0].playlist, layout.widgets[0].playlist);
    assert.deepEqual(new Set(publication.mediaIds), new Set([a.id, b.id]));
    await success('/api/layouts/' + layout.id, { method: 'PUT', body: { ...layout, widgets: [{ ...widget, playlist: [{ mediaId: a.id, muted: false }] }] } });
    const manifest = await success('/api/player/manifest', { auth: false, token: paired.token });
    assert.deepEqual(manifest.programs.find(item => item.id === publication.id).layout.widgets[0].playlist, publication.layout.widgets[0].playlist);
    assert.deepEqual(new Set(manifest.assets.map(item => item.id)), new Set([a.id, b.id]));
    agent = await createPlayer({ dataDir: path.join(directory, 'player'), port: 0, headless: true, connect: false, config: { serverUrl: origin, id: paired.id, token: paired.token } });
    await agent.sync();
    for (const asset of agent.manifest.assets) {
      const bytes = await fs.readFile(path.join(directory, 'player', 'media', asset.sha256));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
    }
    assert.equal((await request('/api/media/' + b.id, { method: 'DELETE' })).status, 409);
  });
  await t.test('backup/restore and offline cold start retain ordered per-video audio choices', async () => {
    const backup = await success('/api/backup');
    assert.deepEqual(backup.state.publications.find(item => item.id === publication.id).layout.widgets[0].playlist, publication.layout.widgets[0].playlist);
    await post('/api/restore', { ...backup, confirm: 'PULIHKAN' });
    assert.deepEqual((await success('/api/state')).publications.find(item => item.id === publication.id).layout.widgets[0].playlist, publication.layout.widgets[0].playlist);
    await agent.close(); agent = null;
    backend.server.closeAllConnections(); await new Promise(resolve => backend.server.close(resolve)); backendOpen = false;
    agent = await createPlayer({ dataDir: path.join(directory, 'player'), port: 0, headless: true, connect: false, config: { serverUrl: origin, id: paired.id, token: paired.token } });
    assert.deepEqual(agent.manifest.programs.find(item => item.id === publication.id).layout.widgets[0].playlist, publication.layout.widgets[0].playlist);
    assert.equal(agent.manifest.assets.length, 2);
  });
});
