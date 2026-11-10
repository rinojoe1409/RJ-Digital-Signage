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
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('YouTube CMS: validated URL, cached local fallback, immutable publish and backup', { timeout: 45000 }, async t => {
  const directory = path.join(root, 'tmp', 'youtube-server-' + randomUUID());
  let backend, player, cookie = '', backendOpen = false;
  await fs.mkdir(directory, { recursive: true });
  t.after(async () => {
    await player?.close();
    if (backendOpen) { backend.server.closeAllConnections(); await new Promise(resolve => backend.server.close(resolve)); }
    assert.ok(path.resolve(directory).startsWith(path.join(root, 'tmp') + path.sep));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });
  backend = await createSignageServer({ dataDir: path.join(directory, 'server') });
  await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
  backendOpen = true;
  const origin = 'http://127.0.0.1:' + backend.server.address().port;
  async function request(route, method = 'GET', body, extra = {}) {
    return fetch(origin + route, { method,
      headers: { 'X-RJ-Request': '1', ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined || Buffer.isBuffer(body) ? {} : { 'Content-Type': 'application/json' }), ...extra },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
  }
  async function success(route, method = 'GET', body, extra) {
    const response = await request(route, method, body, extra);
    const value = await response.json();
    assert.ok(response.ok, route + ': ' + (value.error || response.status));
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return value;
  }
  await success('/api/auth/setup', 'POST', { username: 'qa-youtube', password: randomBytes(24).toString('hex') });
  const widget = { id: 'youtube-live', type: 'youtube', enabled: true, x: 20, y: 20, width: 1280, height: 720,
    youtubeUrl: 'https://www.youtube.com/live/jfKfPfyJRdk?si=discard-this', youtubeVideoId: 'spoofed-id', muted: false, volume: 0.35 };
  let fallback, layout, publication, config;

  await t.test('embed CSP is allowlisted and forwards origin without private paths', async () => {
    const response = await request('/');
    assert.equal(response.status, 200);
    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self' https:\/\/www\.youtube\.com https:\/\/s\.ytimg\.com;/);
    assert.match(csp, /frame-src 'self' https:\/\/www\.youtube\.com https:\/\/www\.youtube-nocookie\.com;/);
    assert.equal(csp.includes('*'), false);
    assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  });

  await t.test('URL input is normalized, IDs are derived, inactive empty drafts are allowed', async () => {
    const inactive = await success('/api/layouts', 'POST', { name: 'YouTube nonaktif', widgets: [{ ...widget, youtubeUrl: '', enabled: false }] });
    assert.equal(inactive.widgets[0].youtubeUrl, '');
    assert.equal(inactive.widgets[0].youtubeVideoId, '');
    const invalid = [
      '', 'javascript:alert(1)', 'https://www.youtube.com.evil.invalid/watch?v=jfKfPfyJRdk',
      'https://evil.invalid/?url=https://www.youtube.com/watch?v=jfKfPfyJRdk',
      'https://rino:secret@www.youtube.com/watch?v=jfKfPfyJRdk',
      'https://www.youtube.com:444/watch?v=jfKfPfyJRdk',
      'https://www.youtube.com/@channel/live', 'https://www.youtube.com/watch?v=short',
    ];
    for (const youtubeUrl of invalid) {
      const response = await request('/api/layouts', 'POST', { name: 'URL invalid', widgets: [{ ...widget, youtubeUrl }] });
      assert.equal(response.status, 400, 'URL berbahaya/tidak langsung harus ditolak');
    }
    assert.equal((await request('/api/layouts', 'POST', { name: 'Dua autoplay aktif', widgets: [widget, { ...widget, id: 'youtube-second' }] })).status, 400);
    const oneActive = await success('/api/layouts', 'POST', { name: 'Satu autoplay aktif', widgets: [widget, { ...widget, id: 'youtube-disabled', youtubeUrl: '', enabled: false }] });
    assert.equal(oneActive.widgets.filter(item => item.type === 'youtube' && item.enabled).length, 1);
    fallback = await success('/api/media', 'POST', png, { 'Content-Type': 'image/png', 'X-Filename': 'cadangan.png' });
    assert.equal((await request('/api/layouts', 'POST', { name: 'Cadangan hilang', widgets: [{ ...widget, fallbackMediaId: 'missing-media' }] })).status, 400);
    layout = await success('/api/layouts', 'POST', { name: 'YouTube Live dengan cadangan', widgets: [{ ...widget, fallbackMediaId: fallback.id }] });
    assert.equal(layout.widgets[0].youtubeUrl, 'https://www.youtube.com/watch?v=jfKfPfyJRdk');
    assert.equal(layout.widgets[0].youtubeVideoId, 'jfKfPfyJRdk');
    assert.equal(layout.widgets[0].muted, false);
    assert.equal(layout.widgets[0].volume, 0.35);
    assert.equal(layout.widgets[0].fallbackMediaId, fallback.id);
  });

  await t.test('publication includes only local fallback assets and protects referenced files', async () => {
    assert.equal((await request('/api/media/' + fallback.id, 'DELETE')).status, 409, 'Cadangan yang dipakai draft tidak boleh dihapus');
    const code = await success('/api/players/pair-code', 'POST', {});
    const paired = await success('/api/player/pair', 'POST', { code: code.code, name: 'QA YouTube fallback' });
    config = { id: paired.id, token: paired.token, serverUrl: origin, name: 'QA YouTube fallback' };
    publication = (await success('/api/layouts/' + layout.id + '/publish', 'POST', { playerIds: [paired.id] })).publication;
    assert.deepEqual(publication.mediaIds, [fallback.id]);
    player = await createPlayer({ dataDir: path.join(directory, 'player'), config, port: 0, headless: true });
    await player.sync();
    assert.equal(player.manifest.defaultPublicationId, publication.id);
    assert.deepEqual(player.manifest.assets.map(asset => asset.id), [fallback.id]);
    assert.equal(player.manifest.assets[0].kind, 'image');
    const downloaded = Buffer.from(await (await fetch(player.address + '/media/' + fallback.id + '/file')).arrayBuffer());
    assert.equal(sha256(downloaded), fallback.sha256);
    await success('/api/layouts/' + layout.id, 'PUT', { ...layout, widgets: [{ ...layout.widgets[0], fallbackMediaId: '' }] });
    assert.equal((await request('/api/media/' + fallback.id, 'DELETE')).status, 409, 'Versi terbit tetap melindungi cadangan meski draft berubah');
  });

  await t.test('backup preserves YouTube configuration and validates fallback references before restore', async () => {
    const backup = await success('/api/backup');
    const saved = backup.state.publications.find(item => item.id === publication.id);
    assert.equal(saved.layout.widgets[0].fallbackMediaId, fallback.id);
    const broken = structuredClone(backup);
    broken.state.publications.find(item => item.id === publication.id).layout.widgets[0].fallbackMediaId = 'missing-media';
    assert.equal((await request('/api/restore', 'POST', { ...broken, confirm: 'PULIHKAN' })).status, 400);
    await success('/api/restore', 'POST', { ...backup, confirm: 'PULIHKAN' });
    const restored = await success('/api/state');
    assert.equal(restored.publications.find(item => item.id === publication.id).layout.widgets[0].youtubeVideoId, 'jfKfPfyJRdk');
  });

  await t.test('cold agent restart retains the local fallback while CMS is offline', async () => {
    await player.close(); player = null;
    backend.server.closeAllConnections(); await new Promise(resolve => backend.server.close(resolve)); backendOpen = false;
    player = await createPlayer({ dataDir: path.join(directory, 'player'), config, port: 0, headless: true, connect: false });
    assert.equal(player.manifest.defaultPublicationId, publication.id);
    const saved = player.manifest.programs.find(item => item.id === publication.id).layout.widgets[0];
    assert.equal(saved.youtubeUrl, 'https://www.youtube.com/watch?v=jfKfPfyJRdk');
    assert.equal(saved.fallbackMediaId, fallback.id);
    const cached = Buffer.from(await (await fetch(player.address + '/media/' + fallback.id + '/file')).arrayBuffer());
    assert.deepEqual(cached, png);
  });
});
