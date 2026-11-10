import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSignageServer } from '../server/server.mjs';
import { createPlayer } from '../player/agent.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RJ_PLAYWRIGHT_PATH || 'playwright');
const until = async (check, message, timeout = 10000) => {
  const limit = Date.now() + timeout;
  while (Date.now() < limit) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error(message);
};

test('Playlist video: ordered editor, individual mute, real clip loop/boundary and offline playback', { timeout: 120000 }, async t => {
  const directory = path.join(root, 'tmp', 'playlist-browser-' + randomUUID());
  const artifacts = path.join(root, 'artifacts');
  let backend, browser, agent, cookie = '', backendOpen = false;
  await fs.mkdir(directory, { recursive: true }); await fs.mkdir(artifacts, { recursive: true });
  backend = await createSignageServer({ dataDir: path.join(directory, 'cms') });
  await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve)); backendOpen = true;
  const origin = 'http://127.0.0.1:' + backend.server.address().port;
  t.after(async () => {
    await browser?.close(); await agent?.close();
    if (backendOpen) { backend.server.closeAllConnections(); await new Promise(resolve => backend.server.close(resolve)); }
    assert.ok(path.resolve(directory).startsWith(path.join(root, 'tmp') + path.sep));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  async function api(route, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(origin + route, { method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), 'X-RJ-Request': '1', ...(body !== undefined && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    const value = await response.json(); assert.ok(response.ok, route + ': ' + (value.error || response.status));
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return value;
  }
  const post = (route, body) => api(route, { method: 'POST', body });
  await post('/api/auth/setup', { username: 'qa-playlist-browser', password: randomBytes(24).toString('hex') });
  const { code } = await post('/api/players/pair-code', {});
  const paired = await post('/api/player/pair', { code, name: 'PC Playlist Uji' });
  browser = await chromium.launch({ ...(process.env.RJ_BROWSER_EXECUTABLE ? { executablePath: process.env.RJ_BROWSER_EXECUTABLE } : {}), headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, timezoneId: 'Asia/Jakarta' });
  await context.addCookies([{ name: 'rj_session', value: cookie.slice(cookie.indexOf('=') + 1), url: origin, httpOnly: true, sameSite: 'Strict' }]);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.locator('.app-shell').waitFor();

  const recordings = await page.evaluate(async () => {
    const results = [];
    for (const [label, colour, length] of [['A', '#008f83', 2600], ['B', '#243b70', 3300]]) {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      Object.assign(canvas.style, { position: 'fixed', left: '0', top: '0', zIndex: '2147483647' });
      document.body.append(canvas); const drawing = canvas.getContext('2d');
      const captured = canvas.captureStream(12), audio = new AudioContext(), destination = audio.createMediaStreamDestination();
      const gain = audio.createGain(); gain.gain.value = 0;
      const oscillator = audio.createOscillator(); oscillator.connect(gain); gain.connect(destination);
      // Keep the real-time audio clock running even when no speaker device is used.
      // The zero gain ensures that the fixture never produces a test sound.
      gain.connect(audio.destination); oscillator.start();
      await audio.resume();
      const audioDeadline = Date.now() + 10000;
      while (audio.currentTime < 0.1) {
        if (Date.now() >= audioDeadline) throw new Error('Audio clock did not start for the silent video fixture.');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      // An encoded silent audio track lets unmuted playback be exercised without
      // playing a test sound on the development computer.
      const stream = new MediaStream([...captured.getVideoTracks(), ...destination.stream.getAudioTracks()]);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus' }), chunks = [];
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      const complete = new Promise((resolve, reject) => {
        recorder.onerror = event => reject(new Error('MediaRecorder fixture: ' + (event.error?.message || 'encoding failed')));
        recorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop()); oscillator.stop(); await audio.close(); canvas.remove();
        const bytes = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
        let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
        resolve({ data: btoa(binary), label, bytes: bytes.length, audioTime: audio.currentTime, chunks: chunks.map(chunk => chunk.size) });
      }; });
      let count = 0;
      const paint = () => { drawing.fillStyle = colour; drawing.fillRect(0, 0, 320, 180); drawing.fillStyle = '#ffffff'; drawing.font = '28px sans-serif'; drawing.fillText('Klip ' + label, 30, 65); drawing.fillRect(count++ % 240, 110, 45, 30); };
      const paintFrame = () => { paint(); captured.getVideoTracks()[0].requestFrame(); };
      recorder.start(100); paintFrame();
      const timer = setInterval(paintFrame, 65);
      setTimeout(() => { clearInterval(timer); recorder.stop(); }, length);
      results.push(await complete);
    }
    return results;
  });
  await fs.writeFile(path.join(artifacts, 'playlist-fixture-diagnostics.json'), JSON.stringify(recordings.map(({ data: _data, ...metadata }) => metadata), null, 2));
  const uploaded = [];
  for (const [index, recording] of recordings.entries()) {
    const bytes = Buffer.from(recording.data, 'base64'); assert.equal(bytes.subarray(0, 4).toString('hex'), '1a45dfa3', 'Real video fixture ' + recording.label + ' must contain a WebM header');
    uploaded.push(await api('/api/media', { method: 'POST', body: bytes, headers: { 'Content-Type': 'video/webm', 'X-Filename': encodeURIComponent('Klip ' + (index ? 'B' : 'A') + ' <uji>.webm') } }));
  }
  const [a, b] = uploaded;
  let layout = await post('/api/layouts', { name: 'Playlist video ruang informasi', width: 1280, height: 720, widgets: [] });
  await page.reload(); await page.locator('.app-shell').waitFor();
  await page.locator('[data-action=navigate][data-view=layouts]').click();
  const card = page.locator('.layout-card').filter({ hasText: layout.name });
  await card.locator('button[data-action=edit-layout]').click();
  await page.locator('[data-action=add-widget][data-type=video-playlist]').click();
  const widgetId = await page.locator('.widget-outline.selected').getAttribute('data-widget');
  const selectWidget = async () => page.locator('[data-action=select-widget][data-id="' + widgetId + '"]').click();
  const addClips = async ids => {
    await page.locator('[data-action=playlist-add]').click();
    for (const id of ids) await page.locator('input[name=playlistMediaIds][value="' + id + '"]').check();
    await page.locator('#modal-form button[type=submit]').click();
    await page.locator('#modal').waitFor({ state: 'hidden' });
  };
  await addClips([a.id, b.id]);
  assert.equal(await page.locator('.video-playlist-item').count(), 2);
  await page.locator('[data-action=playlist-up][data-id="1"]').click();
  await addClips([b.id]);
  assert.equal(await page.locator('.video-playlist-item').count(), 3);
  await page.locator('[data-playlist-muted="0"]').uncheck();
  await page.locator('[data-action=undo]').click(); await selectWidget();
  assert.equal(await page.locator('[data-playlist-muted="0"]').isChecked(), true, 'Undo restores the clip audio choice');
  await page.locator('[data-action=redo]').click(); await selectWidget();
  assert.equal(await page.locator('[data-playlist-muted="0"]').isChecked(), false, 'Redo restores per-video sound');
  await page.locator('[data-action=playlist-remove][data-id="2"]').click();
  assert.equal(await page.locator('.video-playlist-item').count(), 2);
  await page.locator('[data-action=undo]').click(); await selectWidget();
  assert.equal(await page.locator('.video-playlist-item').count(), 3, 'Removing a clip can be undone');
  assert.equal(await page.locator('#canvas-render video').count(), 0, 'Editor uses a silent static playlist placeholder');
  await page.locator('[data-action=save-layout]').click();
  layout = (await api('/api/state')).layouts.find(item => item.id === layout.id);
  const expected = [{ mediaId: b.id, muted: false }, { mediaId: a.id, muted: true }, { mediaId: b.id, muted: true }];
  const choices = playlist => playlist.map(({ mediaId, muted }) => ({ mediaId, muted }));
  assert.deepEqual(choices(layout.widgets[0].playlist), expected);
  await page.screenshot({ path: path.join(artifacts, 'playlist-desktop.png'), fullPage: true });

  await page.locator('[data-action=close-editor]').click();
  await card.locator('button[data-action=edit-layout]').click(); await selectWidget();
  assert.equal(await page.locator('[data-playlist-muted="0"]').isChecked(), false);
  assert.equal(await page.locator('[data-playlist-muted="1"]').isChecked(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Playlist editor fits a phone viewport');
  await page.locator('.video-playlist-item').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(artifacts, 'playlist-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator('[data-action=preview-editor]').click();
  const preview = page.frameLocator('#preview-modal iframe');
  await preview.locator('.rj-widget-video video').waitFor();
  await until(async () => preview.locator('video').evaluate(video => video.currentTime > 0.1 && !video.paused), 'Preview did not decode the first clip');
  assert.equal(await preview.locator('video').evaluate(video => video.muted), false);
  await page.locator('#preview-modal [data-action=close-modal]').click();

  const publication = (await post('/api/layouts/' + layout.id + '/publish', { playerIds: [paired.id] })).publication;
  const playerDirectory = path.join(directory, 'player');
  const config = { serverUrl: origin, id: paired.id, token: paired.token, name: 'PC Playlist Uji' };
  agent = await createPlayer({ dataDir: playerDirectory, port: 0, headless: true, config });
  await agent.sync(); assert.equal(agent.manifest.defaultPublicationId, publication.id);
  const playerPage = await context.newPage(); playerPage.on('pageerror', error => errors.push(error.message));
  await playerPage.addInitScript(() => {
    window.__playlistTrace = [];
    for (const type of ['playing', 'ended']) document.addEventListener(type, event => {
      const video = event.target;
      if (!(video instanceof HTMLVideoElement) || !video.closest('.rj-widget-video')) return;
      window.__playlistTrace.push({ event: type, id: video.currentSrc.match(/\/media\/([^/]+)\/file/)?.[1], muted: video.muted, time: video.currentTime, duration: video.duration });
    }, true);
  });
  await playerPage.goto(agent.address + '/player.html');
  await playerPage.waitForFunction(() => window.__playlistTrace.filter(item => item.event === 'playing').length >= 4, null, { timeout: 20000 });
  const firstCycle = await playerPage.evaluate(() => window.__playlistTrace.filter(item => item.event === 'playing').slice(0, 4).map(({ id, muted }) => ({ id, muted })));
  assert.deepEqual(firstCycle, [{ id: b.id, muted: false }, { id: a.id, muted: true }, { id: b.id, muted: true }, { id: b.id, muted: false }], 'Real decoded videos preserve order, duplicate clips, independent audio and looping');

  // The fourth start is the beginning of the next loop. Publish while that clip
  // is playing and prove the current clip reaches ended without waiting a cycle.
  await playerPage.waitForFunction(id => {
    const video = document.querySelector('.rj-widget-video video');
    return video?.currentSrc.includes(id) && video.currentTime > 0.1 && video.currentTime < 0.7 && !video.muted;
  }, b.id, { timeout: 15000 });
  const boundaryStart = await playerPage.evaluate(() => { window.__boundaryTraceStart = window.__playlistTrace.length; return document.querySelector('video').currentTime; });
  const next = await post('/api/layouts', { name: 'Sesudah playlist', widgets: [{ id: 'next-text', type: 'text', text: 'Tayangan berikutnya setelah klip selesai', width: 1200, height: 200 }] });
  const changeStarted = Date.now();
  await post('/api/layouts/' + next.id + '/publish', { playerIds: [paired.id] }); await agent.sync();
  await playerPage.getByText('Tayangan berikutnya setelah klip selesai', { exact: true }).waitFor({ timeout: 7000 });
  const boundaryEvents = await playerPage.evaluate(() => window.__playlistTrace.slice(window.__boundaryTraceStart));
  assert.ok(boundaryStart < 0.7);
  assert.ok(boundaryEvents.some(event => event.event === 'ended' && event.id === b.id && event.time > 2.5), 'Current clip actually ends before switching');
  assert.equal(boundaryEvents.some(event => event.event === 'playing'), false, 'Pending publish does not start the remaining playlist clips');
  assert.ok(Date.now() - changeStarted < 6000, 'Publish waits one clip rather than the whole playlist');

  const cachedPublication = (await post('/api/layouts/' + layout.id + '/publish', { playerIds: [paired.id] })).publication;
  await agent.sync(); await agent.close(); agent = null;
  backend.server.closeAllConnections(); await new Promise(resolve => backend.server.close(resolve)); backendOpen = false;
  agent = await createPlayer({ dataDir: playerDirectory, port: 0, headless: true, connect: false, config });
  await playerPage.goto(agent.address + '/player.html');
  await playerPage.waitForFunction(() => window.__playlistTrace.filter(item => item.event === 'playing').length >= 2, null, { timeout: 10000 });
  const offline = await playerPage.evaluate(() => window.__playlistTrace.filter(item => item.event === 'playing').slice(0, 2).map(({ id, muted }) => ({ id, muted })));
  assert.deepEqual(offline, [{ id: b.id, muted: false }, { id: a.id, muted: true }]);
  assert.equal(agent.manifest.defaultPublicationId, cachedPublication.id); assert.equal(agent.manifest.assets.length, 2);
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(artifacts, 'playlist-browser-result.json'), JSON.stringify({
    actualVideoDecode: true, encodedSilentAudioTracks: true, orderedDuplicateClipsAndLoop: true,
    perVideoMutePassed: true, editorStaticNoVideo: true, orderedEditorSaveReopen: true, undoRedoPassed: true,
    previewPlaybackPassed: true, currentClipBoundaryPassed: true, offlineColdStartPassed: true,
    mobileNoHorizontalOverflow: true, browserErrors: errors,
  }, null, 2));
});
