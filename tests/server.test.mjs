import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/wlYAAAAASUVORK5CYII=', 'base64');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function unusedPort() {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

function containsPrivateFields(value) {
  if (!value || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value)) {
    if (/^(password|passwordHash|token|tokenHash|setupToken|sessions|pairCodes)$/i.test(key)) return true;
    if (containsPrivateFields(child)) return true;
  }
  return false;
}

async function sseClient(baseUrl, token) {
  const abort = new AbortController();
  const response = await fetch(`${baseUrl}/api/player/events`, {
    headers: { Authorization: `Bearer ${token}` }, signal: abort.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    close: () => abort.abort(),
    async next(expected, timeout = 6000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        let delimiter;
        while ((delimiter = buffer.search(/\r?\n\r?\n/)) !== -1) {
          const chunk = buffer.slice(0, delimiter);
          buffer = buffer.slice(delimiter).replace(/^\r?\n\r?\n/, '');
          const event = chunk.match(/^event:\s*(.+)$/m)?.[1]?.trim() ?? 'message';
          if (event !== expected) continue;
          const data = chunk.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          return data ? JSON.parse(data) : null;
        }
        const remaining = Math.max(1, deadline - Date.now());
        let timer;
        const packet = await Promise.race([
          reader.read(),
          new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error(`SSE ${expected} tidak tiba dalam batas waktu`)); }, remaining); }),
        ]).finally(() => clearTimeout(timer));
        assert.equal(packet.done, false, 'Koneksi SSE berhenti sebelum event diterima');
        buffer += decoder.decode(packet.value, { stream: true });
      }
      throw new Error(`SSE ${expected} tidak diterima`);
    },
  };
}

test('server HTTP: authorization, immutable publish, delivery, schedule, and recovery', { timeout: 120_000 }, async t => {
  const tempRoot = path.join(project, 'tmp');
  await mkdir(tempRoot, { recursive: true });
  const dataDir = await mkdtemp(path.join(tempRoot, 'server-tests-'));
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const secret = ` Uji-${randomBytes(22).toString('base64url')}!9 `;
  const username = 'uji-admin';
  let cookie = '';
  let exitCode = null;
  const processHandle = spawn(process.execPath, ['server/server.mjs'], {
    cwd: project,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), SIGNAGE_DATA_DIR: dataDir, NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true,
  });
  let exited = false;
  const closed = new Promise(resolve => processHandle.once('close', code => { exited = true; exitCode = code; resolve(); }));
  processHandle.once('error', () => { exited = true; });
  let events;
  t.after(async () => {
    events?.close();
    if (!exited) processHandle.kill('SIGTERM');
    await Promise.race([closed, delay(3000)]);
    if (!exited) processHandle.kill('SIGKILL');
    await Promise.race([closed, delay(1000)]);
    const resolved = path.resolve(dataDir);
    assert.ok(resolved.startsWith(`${path.resolve(tempRoot)}${path.sep}server-tests-`), 'Cleanup dibatasi ke direktori temporer tes sendiri');
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  });

  for (let attempt = 0; attempt < 150; attempt++) {
    if (exited) throw new Error(`Server uji gagal mulai (exit ${exitCode ?? 'tidak diketahui'}).`);
    try {
      const response = await fetch(`${baseUrl}/api/auth/status`);
      if (response.ok) break;
    } catch { /* Give the newly spawned process time to bind its loopback port. */ }
    if (attempt === 149) throw new Error('Server uji belum siap setelah 15 detik.');
    await delay(100);
  }

  async function request(route, { method = 'GET', json, body, auth = true, token, headers = {}, mutationHeader = true, origin = baseUrl } = {}) {
    const allHeaders = { ...headers };
    if (auth && cookie) allHeaders.Cookie = cookie;
    if (token) allHeaders.Authorization = `Bearer ${token}`;
    if (origin) allHeaders.Origin = origin;
    if (method !== 'GET' && method !== 'HEAD' && mutationHeader) allHeaders['X-RJ-Request'] = '1';
    if (json !== undefined) {
      allHeaders['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    return fetch(`${baseUrl}${route}`, { method, headers: allHeaders, body });
  }
  async function success(route, options = {}) {
    const response = await request(route, options);
    assert.ok(response.ok, `${options.method ?? 'GET'} ${route} gagal dengan HTTP ${response.status}`);
    const body = response.status === 204 ? null : await response.json();
    return { response, body };
  }
  const context = {};

  await t.test('initial setup is explicit, validates passwords, and protects dashboard state', async () => {
    const initial = await success('/api/auth/status', { auth: false });
    assert.equal(initial.body.initialized, false);
    assert.equal(initial.body.authenticated, false);
    assert.equal((await request('/api/state', { auth: false })).status, 401);
    const weak = await request('/api/auth/setup', { method: 'POST', auth: false, json: { username, password: '12345' } });
    assert.equal(weak.status, 400);
    const setup = await success('/api/auth/setup', { method: 'POST', auth: false, json: { username, password: secret } });
    const setCookie = setup.response.headers.get('set-cookie');
    assert.ok(setCookie, 'Setup membuat sesi browser');
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    cookie = setCookie.split(';')[0];
    const repeated = await request('/api/auth/setup', { method: 'POST', json: { username: 'second-admin', password: secret } });
    assert.ok([400, 403, 409].includes(repeated.status), 'Setup tidak boleh mengganti admin yang sudah ada');
    assert.equal((await success('/api/auth/status')).body.authenticated, true);
  });

  await t.test('session and cross-origin mutation boundaries are enforced', async () => {
    const badLogin = await request('/api/auth/login', { method: 'POST', auth: false, json: { username, password: `${secret}-wrong` } });
    assert.equal(badLogin.status, 401);
    const missingHeader = await request('/api/layouts', { method: 'POST', mutationHeader: false, json: { name: 'Tidak boleh dibuat' } });
    assert.ok([400, 403].includes(missingHeader.status));
    const externalOrigin = await request('/api/layouts', { method: 'POST', origin: 'http://example.invalid', json: { name: 'Tidak boleh dibuat' } });
    assert.equal(externalOrigin.status, 403);
    const login = await success('/api/auth/login', { method: 'POST', auth: false, json: { username, password: secret } });
    assert.equal(login.body.user.username, username);
    cookie = login.response.headers.get('set-cookie').split(';')[0];
  });

  await t.test('uploads are authenticated, validate actual file content, and support byte ranges', async () => {
    const denied = await request('/api/media', { method: 'POST', auth: false, body: png, headers: { 'Content-Type': 'image/png', 'X-Filename': 'poster.png' } });
    assert.equal(denied.status, 401);
    const invalid = await request('/api/media', { method: 'POST', body: Buffer.from('<script>alert(1)</script>'), headers: { 'Content-Type': 'image/png', 'X-Filename': 'palsu.png' } });
    assert.ok([400, 415].includes(invalid.status));
    const media = await success('/api/media', { method: 'POST', body: png, headers: { 'Content-Type': 'image/png', 'X-Filename': encodeURIComponent('Poster uji.png') } });
    context.media = media.body;
    assert.ok(context.media.id);
    assert.equal(context.media.kind, 'image');
    assert.equal(context.media.size, png.byteLength);
    assert.equal(context.media.sha256, sha256(png));
    assert.equal((await request(`/api/media/${context.media.id}/file`, { auth: false })).status, 401);
    const range = await request(`/api/media/${context.media.id}/file`, { headers: { Range: 'bytes=0-7' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), `bytes 0-7/${png.length}`);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), png.subarray(0, 8));
    assert.equal((await request(`/api/media/${context.media.id}/file`, { headers: { Range: 'bytes=99999-' } })).status, 416);
  });

  await t.test('pair codes are single use and player credentials are isolated from the dashboard', async () => {
    const code = (await success('/api/players/pair-code', { method: 'POST', json: {} })).body;
    assert.match(code.code, /^\d{6}$/);
    assert.ok(Date.parse(code.expiresAt) > Date.now());
    const pair = (await success('/api/player/pair', { method: 'POST', auth: false, json: { code: code.code, name: 'Player Uji Windows' } })).body;
    assert.ok(pair.id);
    assert.ok(pair.token?.length >= 32);
    context.player = pair;
    assert.ok([400, 401, 403, 409].includes((await request('/api/player/pair', { method: 'POST', auth: false, json: { code: code.code, name: 'Tidak boleh berpasangan' } })).status));
    assert.equal((await request('/api/player/manifest')).status, 401, 'Cookie dashboard tidak menggantikan identitas player');
    assert.equal((await request('/api/player/manifest', { auth: false, token: 'invalid-player-token' })).status, 401);
    const state = (await success('/api/state')).body;
    assert.ok(state.players.some(player => player.id === pair.id));
    assert.equal(containsPrivateFields(state), false);
    assert.equal(JSON.stringify(state).includes(pair.token), false);
    const unauthorizedMedia = await request(`/api/player/media/${context.media.id}/file`, { auth: false, token: pair.token });
    assert.ok([403, 404].includes(unauthorizedMedia.status), 'Player tidak boleh mengambil aset yang belum ditugaskan');
  });

  await t.test('publishing pushes an SSE update and creates an immutable complete manifest', async () => {
    context.layout = (await success('/api/layouts', { method: 'POST', json: {
      name: 'Layout Uji Awal', width: 1920, height: 1080, background: '#123344', duration: 30,
      widgets: [
        { id: 'img-a', type: 'image', enabled: true, x: 0, y: 0, width: 800, height: 600, mediaId: context.media.id, fit: 'contain' },
        { id: 'text-a', type: 'text', enabled: true, x: 900, y: 100, width: 800, height: 200, text: 'Versi pertama', fontSize: 48, color: '#ffffff' },
        { id: 'ticker-a', type: 'ticker', enabled: false, x: 0, y: 900, width: 1920, height: 100, text: 'Teks opsional' },
        { id: 'prayer-a', type: 'prayer', enabled: false, x: 900, y: 500, width: 900, height: 300 },
      ],
    } })).body;
    events = await sseClient(baseUrl, context.player.token);
    await events.next('hello');
    context.firstPublication = (await success(`/api/layouts/${context.layout.id}/publish`, { method: 'POST', json: { playerIds: [context.player.id] } })).body.publication;
    assert.ok(context.firstPublication.id);
    await events.next('update');
    const manifest = (await success('/api/player/manifest', { auth: false, token: context.player.token })).body;
    context.firstManifest = manifest;
    assert.equal(manifest.schema, 1);
    assert.equal(manifest.defaultPublicationId, context.firstPublication.id);
    assert.ok(manifest.programs.some(program => program.id === context.firstPublication.id));
    assert.ok(manifest.assets.some(asset => asset.id === context.media.id && asset.sha256 === sha256(png)));
    assert.equal(containsPrivateFields(manifest), false);
    const same = (await success('/api/player/manifest', { auth: false, token: context.player.token })).body;
    assert.equal(same.generation, manifest.generation, 'serverTime tidak boleh membuat generation berubah setiap request');
    const downloaded = await request(`/api/player/media/${context.media.id}/file`, { auth: false, token: context.player.token });
    assert.equal(downloaded.status, 200);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);
    context.changedDraft = { ...context.layout, name: 'Draft diubah', widgets: context.layout.widgets.map(widget => widget.type === 'text' ? { ...widget, text: 'Belum diterbitkan' } : widget) };
    await success(`/api/layouts/${context.layout.id}`, { method: 'PUT', json: context.changedDraft });
    const stillPublished = (await success('/api/player/manifest', { auth: false, token: context.player.token })).body;
    const oldProgram = stillPublished.programs.find(program => program.id === context.firstPublication.id);
    assert.equal(oldProgram.layout.name, 'Layout Uji Awal');
    assert.equal(oldProgram.layout.widgets.find(widget => widget.type === 'text').text, 'Versi pertama');
    assert.equal(stillPublished.generation, manifest.generation);
    assert.ok([400, 409].includes((await request(`/api/media/${context.media.id}`, { method: 'DELETE' })).status), 'Aset yang dipakai dilindungi');
  });

  await t.test('heartbeats and screenshot acknowledgments describe the real player state', async () => {
    await success('/api/player/heartbeat', { method: 'POST', auth: false, token: context.player.token, json: {
      status: 'playing', progress: 100, currentPublicationId: context.firstPublication.id,
      downloadedGeneration: context.firstManifest.generation, screen: { width: 1920, height: 1080 },
    } });
    const player = (await success('/api/state')).body.players.find(item => item.id === context.player.id);
    assert.equal(player.online, true);
    assert.equal(player.currentPublicationId, context.firstPublication.id);
    assert.equal(player.status, 'playing');
    await success(`/api/players/${context.player.id}/action`, { method: 'POST', json: { action: 'screenshot' } });
    await events.next('screenshot');
    const response = await request('/api/player/screenshot', { method: 'POST', auth: false, token: context.player.token, body: png, headers: { 'Content-Type': 'image/png' } });
    assert.ok(response.ok, `Screenshot gagal HTTP ${response.status}`);
    const updated = (await success('/api/state')).body.players.find(item => item.id === context.player.id);
    assert.ok(updated.screenshotUrl);
    assert.ok(updated.screenshotAt);
    const shot = await request(updated.screenshotUrl);
    assert.equal(shot.status, 200);
    assert.deepEqual(Buffer.from(await shot.arrayBuffer()), png);
    assert.equal((await request(updated.screenshotUrl, { auth: false })).status, 401);
  });

  await t.test('schedules pre-load their immutable programs and reject invalid time windows', async () => {
    const now = Date.now();
    const scheduled = (await success('/api/schedules', { method: 'POST', json: {
      name: 'Jadwal uji', layoutId: context.layout.id, playerIds: [context.player.id],
      startAt: new Date(now + 3600_000).toISOString(), endAt: new Date(now + 7200_000).toISOString(),
      repeat: 'daily', priority: 10, enabled: true,
    } })).body;
    context.schedule = scheduled;
    assert.ok(scheduled.id);
    assert.ok(scheduled.publicationId);
    const manifest = (await success('/api/player/manifest', { auth: false, token: context.player.token })).body;
    assert.ok(manifest.schedules.some(schedule => schedule.id === scheduled.id));
    assert.ok(manifest.programs.some(program => program.id === scheduled.publicationId), 'Jadwal masa depan harus siap untuk pemutaran offline');
    assert.notEqual(manifest.generation, context.firstManifest.generation);
    const invalid = await request('/api/schedules', { method: 'POST', json: {
      name: 'Jadwal invalid', layoutId: context.layout.id, playerIds: [context.player.id],
      startAt: new Date(now + 7200_000).toISOString(), endAt: new Date(now + 3600_000).toISOString(), repeat: 'once', enabled: true,
    } });
    assert.equal(invalid.status, 400);
  });

  await t.test('settings validate location and timezone without an external service', async () => {
    const state = (await success('/api/state')).body;
    const invalidTimezone = await request('/api/settings', { method: 'PUT', json: { ...state.settings, timezone: 'Not/A_Real_Zone' } });
    assert.equal(invalidTimezone.status, 400);
    const invalidLocation = await request('/api/settings', { method: 'PUT', json: { ...state.settings, latitude: 999 } });
    assert.equal(invalidLocation.status, 400);
    const settings = { ...state.settings, locationName: 'Jakarta Uji', prayer: { ...state.settings.prayer, adjustments: { fajr: 1, dhuhr: 0, asr: 0, maghrib: 2, isha: 0 } } };
    await success('/api/settings', { method: 'PUT', json: settings });
    const manifest = (await success('/api/player/manifest', { auth: false, token: context.player.token })).body;
    assert.equal(manifest.settings.locationName, 'Jakarta Uji');
    assert.equal(manifest.settings.prayer.adjustments.maghrib, 2);
  });

  await t.test('rollback restores a previously published version rather than an edited draft', async () => {
    const second = (await success(`/api/layouts/${context.layout.id}/publish`, { method: 'POST', json: { playerIds: [context.player.id] } })).body.publication;
    assert.notEqual(second.id, context.firstPublication.id);
    assert.equal(second.layout.name, 'Draft diubah');
    await success(`/api/players/${context.player.id}/action`, { method: 'POST', json: { action: 'rollback' } });
    const manifest = (await success('/api/player/manifest', { auth: false, token: context.player.token })).body;
    assert.equal(manifest.manualOverride?.publicationId ?? manifest.defaultPublicationId, context.firstPublication.id);
    const restored = manifest.programs.find(program => program.id === context.firstPublication.id);
    assert.equal(restored.layout.name, 'Layout Uji Awal');
  });

  await t.test('backup omits secrets and restoration preserves existing administrator/player access', async () => {
    events.close();
    const backup = (await success('/api/backup')).body;
    assert.equal(containsPrivateFields(backup), false);
    const encoded = JSON.stringify(backup);
    assert.equal(encoded.includes(context.player.token), false);
    assert.equal(encoded.includes(secret), false);
    const protectedRestore = await request('/api/restore', { method: 'POST', json: backup });
    assert.equal(protectedRestore.status, 400, 'Restore harus meminta konfirmasi eksplisit');
    const stableState = state => JSON.stringify({ media: state.media, layouts: state.layouts, publications: state.publications, schedules: state.schedules, settings: state.settings, players: state.players });
    const stateBeforeInvalid = stableState((await success('/api/state')).body);
    const assertInvalidArchive = async (invalid, description) => {
      const rejected = await request('/api/restore', { method: 'POST', json: { ...invalid, confirm: 'PULIHKAN' } });
      assert.equal(rejected.status, 400, description);
      const after = (await success('/api/state')).body;
      assert.equal(stableState(after), stateBeforeInvalid, 'Arsip invalid tidak boleh mengubah konfigurasi atau versi aktif');
      const currentFile = await request(`/api/media/${context.media.id}/file`);
      assert.equal(currentFile.status, 200);
      assert.deepEqual(Buffer.from(await currentFile.arrayBuffer()), png, 'Arsip invalid tidak boleh mengubah berkas media aktif');
    };
    const corruptChecksum = structuredClone(backup);
    const corruptFile = corruptChecksum.files.find(file => file.id === context.media.id);
    const corruptBytes = Buffer.from(corruptFile.data, 'base64');
    corruptBytes[corruptBytes.length - 1] ^= 1;
    corruptFile.data = corruptBytes.toString('base64');
    await assertInvalidArchive(corruptChecksum, 'Restore menolak checksum media yang berubah');
    const traversal = structuredClone(backup);
    traversal.files[0].id = '../../outside-media';
    await assertInvalidArchive(traversal, 'Restore menolak ID berkas yang mencoba keluar dari folder media');
    const collidingId = structuredClone(corruptChecksum);
    collidingId.state.media.find(media => media.id === context.media.id).sha256 = sha256(corruptBytes);
    await assertInvalidArchive(collidingId, 'Restore menolak penggantian isi aset aktif memakai ID lama');
    const invalidPlayer = structuredClone(backup);
    invalidPlayer.state.players.find(player => player.id === context.player.id).history = 'not-an-array';
    await assertInvalidArchive(invalidPlayer, 'Restore memvalidasi riwayat player sebelum menulis berkas');
    const extra = (await success('/api/layouts', { method: 'POST', json: { name: 'Dibuat setelah backup' } })).body;
    await success('/api/restore', { method: 'POST', json: { ...backup, confirm: 'PULIHKAN' } });
    const restored = (await success('/api/state')).body;
    assert.equal(restored.layouts.some(layout => layout.id === extra.id), false);
    assert.ok(restored.layouts.some(layout => layout.id === context.layout.id));
    assert.ok(restored.media.some(media => media.id === context.media.id));
    assert.equal((await request('/api/player/manifest', { auth: false, token: context.player.token })).status, 200, 'Player yang telah terdaftar tetap dapat terhubung');
    const login = await request('/api/auth/login', { method: 'POST', auth: false, json: { username, password: secret } });
    assert.equal(login.status, 200, 'Password admin tidak diganti dari arsip');
    const files = await readdir(dataDir, { recursive: true });
    assert.ok(files.some(name => /backup|safety|snapshot|restore/i.test(String(name))), 'Restore membuat cadangan keselamatan');
  });

  await t.test('revoked players and logged-out sessions immediately lose access', async () => {
    await success(`/api/players/${context.player.id}/action`, { method: 'POST', json: { action: 'revoke' } });
    assert.equal((await request('/api/player/manifest', { auth: false, token: context.player.token })).status, 401);
    await success('/api/auth/logout', { method: 'POST', json: {} });
    assert.equal((await request('/api/state')).status, 401);
    assert.equal((await success('/api/auth/status')).body.authenticated, false);
  });
});
