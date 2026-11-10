import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSignageServer } from '../server/server.mjs';
import { createPlayer } from '../player/agent.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const runtimeModules = process.env.RJ_PLAYWRIGHT_PATH || 'playwright';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/wlYAAAAASUVORK5CYII=', 'base64');
const videoId = 'M7lc1UVf-VE';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, message, timeout = 15000) {
  const limit = Date.now() + timeout;
  while (Date.now() < limit) { if (await check()) return; await pause(60); }
  throw new Error(message);
}

// This mock replaces the public YouTube API transport only. CMS validation, immutable
// publications, SSE, media download/hash checks, renderer and player code are real.
// It cannot prove that an external livestream permits embedding or actually plays.
const iframeApiMock = String.raw`
(() => {
  const mock = window.__ytMock = { instances: [], calls: [], autoReady: true };
  const states = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
  class MockPlayer {
    constructor(target, settings = {}) {
      let frame = typeof target === 'string' ? document.getElementById(target) : target;
      if (!frame) throw Error('YouTube target missing');
      if (frame.tagName !== 'IFRAME') {
        const replacement = document.createElement('iframe');
        for (const attribute of frame.attributes) replacement.setAttribute(attribute.name, attribute.value);
        frame.replaceWith(replacement); frame = replacement;
      }
      this.frame = frame; this.settings = settings; this.state = -1; this.current = 12;
      this.muted = false; this.volume = 100; this.destroyed = false;
      this.videoId = settings.videoId || new URL(frame.src).pathname.split('/').pop();
      if (!frame.src) frame.src = 'https://www.youtube-nocookie.com/embed/' + this.videoId;
      mock.instances.push(this); mock.calls.push({ method: 'create', videoId: this.videoId });
      queueMicrotask(() => { if (mock.autoReady && !this.destroyed) this.emit('onReady'); });
    }
    emit(type, data) {
      const event = { target: this, data };
      if (type === 'onStateChange') this.state = data;
      if (typeof this.settings.events?.[type] === 'function') this.settings.events[type](event);
    }
    playVideo() { mock.calls.push({ method: 'playVideo' }); this.state = 1; this.emit('onStateChange', 1); }
    pauseVideo() { this.state = 2; mock.calls.push({ method: 'pauseVideo' }); }
    stopVideo() { this.state = 0; mock.calls.push({ method: 'stopVideo' }); }
    mute() { this.muted = true; mock.calls.push({ method: 'mute' }); }
    unMute() { this.muted = false; mock.calls.push({ method: 'unMute' }); }
    isMuted() { return this.muted; }
    setVolume(value) { this.volume = value; mock.calls.push({ method: 'setVolume', value }); }
    getVolume() { return this.volume; }
    getIframe() { return this.frame; }
    getPlayerState() { return this.state; }
    getCurrentTime() { return this.current; }
    getDuration() { return 0; }
    getVideoData() { return { video_id: this.videoId, isLive: true }; }
    destroy() { this.destroyed = true; this.frame.remove(); mock.calls.push({ method: 'destroy' }); }
  }
  mock.last = () => mock.instances.filter(player => !player.destroyed).at(-1);
  mock.emit = (type, data) => { const player = mock.last(); if (!player) throw Error('No active mock player'); player.emit(type, data); };
  window.YT = { Player: MockPlayer, PlayerState: states, ready: callback => queueMicrotask(callback) };
  queueMicrotask(() => window.onYouTubeIframeAPIReady?.());
})();`;

async function mockedContext(browser, { blockYouTube = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const requests = { api: [], embeds: [], blocked: [] };
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) { await route.continue(); return; }
    if (url.hostname === 'www.youtube.com' && url.pathname === '/iframe_api') {
      requests.api.push(request.url());
      if (blockYouTube) await route.abort('internetdisconnected');
      else await route.fulfill({ status: 200, contentType: 'application/javascript', body: iframeApiMock });
      return;
    }
    if (['www.youtube.com', 'www.youtube-nocookie.com'].includes(url.hostname) && url.pathname.startsWith('/embed/')) {
      requests.embeds.push({ url: request.url(), referer: request.headers().referer || '' });
      if (blockYouTube) await route.abort('internetdisconnected');
      else await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>YouTube API transport mock</title>' });
      return;
    }
    requests.blocked.push(request.url()); await route.abort('blockedbyclient');
  });
  return { context, requests };
}

test('YouTube mocked transport: real CMS/agent publish, fallback cache, static editor, live transitions and offline fallback', { timeout: 150000 }, async t => {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(runtimeModules)); }
  const directory = path.join(root, 'tmp', 'youtube-browser-' + randomUUID());
  await fs.mkdir(directory, { recursive: true });
  let backend, browser, player, cookie = '';
  t.after(async () => {
    await browser?.close(); await player?.close();
    if (backend) { backend.server.closeAllConnections(); await new Promise(resolve => backend.server.close(resolve)); }
    assert.ok(path.resolve(directory).startsWith(path.join(root, 'tmp') + path.sep));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  backend = await createSignageServer({ dataDir: path.join(directory, 'server') });
  await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + backend.server.address().port;
  async function api(route, { method = 'GET', json, body, headers = {} } = {}) {
    const response = await fetch(base + route, { method,
      headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { 'X-RJ-Request': '1' } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) },
      body: json ? JSON.stringify(json) : body,
    });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    assert.ok(response.ok, method + ' ' + route + ' HTTP ' + response.status);
    return response;
  }
  await api('/api/auth/setup', { method: 'POST', json: { username: 'qa-youtube', password: randomBytes(24).toString('hex') } });
  const fallback = await (await api('/api/media', { method: 'POST', body: png, headers: { 'Content-Type': 'image/png', 'X-Filename': 'cadangan-youtube.png' } })).json();
  const live = await (await api('/api/layouts', { method: 'POST', json: { name: 'QA YouTube Live', width: 1280, height: 720, widgets: [
    { id: 'youtube-main', type: 'youtube', enabled: true, x: 0, y: 0, width: 1280, height: 720, youtubeUrl: 'https://www.youtube.com/live/' + videoId, fallbackMediaId: fallback.id, muted: true, volume: 0.35 },
  ] } })).json();
  assert.equal(live.widgets[0].youtubeVideoId, videoId);
  const code = await (await api('/api/players/pair-code', { method: 'POST', json: {} })).json();
  const paired = await (await api('/api/player/pair', { method: 'POST', json: { code: code.code, name: 'QA YouTube player' } })).json();
  const playerDirectory = path.join(directory, 'player');
  const config = { serverUrl: base, id: paired.id, token: paired.token, name: 'QA YouTube player' };
  player = await createPlayer({ dataDir: playerDirectory, port: 0, config, headless: true });
  browser = await chromium.launch({ ...(process.env.RJ_BROWSER_EXECUTABLE ? { executablePath: process.env.RJ_BROWSER_EXECUTABLE } : {}), headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const mocked = await mockedContext(browser);
  await mocked.context.addCookies([{ name: 'rj_session', value: cookie.split('=')[1], url: base, httpOnly: true, sameSite: 'Strict' }]);
  const page = await mocked.context.newPage(), pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(base + '/');
  await page.locator('h1', { hasText: 'Ringkasan' }).waitFor();
  await page.locator('[data-action=navigate][data-view=layouts]').click();
  await page.locator('button[data-action=edit-layout][data-id="' + live.id + '"]').click();
  await page.locator('#canvas-stage').waitFor();
  await page.waitForFunction(() => document.querySelector('#canvas-render .rj-widget-youtube'));
  assert.equal(mocked.requests.api.length, 0, 'Editor dan thumbnail statis tidak menghubungi YouTube');
  assert.equal(mocked.requests.embeds.length, 0, 'Editor statis tidak membuat iframe eksternal');

  const publication = (await (await api('/api/layouts/' + live.id + '/publish', { method: 'POST', json: { playerIds: [paired.id] } })).json()).publication;
  await until(() => player.manifest?.defaultPublicationId === publication.id && player.status.progress === 100, 'Manifest YouTube belum diterima');
  const cachedAsset = player.manifest.assets.find(asset => asset.id === fallback.id);
  assert.ok(cachedAsset, 'Fallback ikut dikirim ke cache player');
  const cachedBytes = await fs.readFile(path.join(playerDirectory, 'media', cachedAsset.sha256));
  assert.equal(createHash('sha256').update(cachedBytes).digest('hex'), fallback.sha256);
  assert.deepEqual(cachedBytes, png);
  await page.goto(player.address + '/player.html');
  await page.waitForFunction(() => window.__ytMock?.last()?.state === 1);
  assert.equal(await page.evaluate(() => window.__ytMock.last().muted), true);
  assert.equal(await page.evaluate(() => window.__ytMock.last().volume), 35);
  assert.match(await page.locator('.rj-widget-youtube iframe').getAttribute('src'), /^https:\/\/www\.youtube-nocookie\.com\/embed\//);
  await until(() => mocked.requests.embeds.length > 0, 'Permintaan iframe belum diamati');
  assert.ok(mocked.requests.embeds.some(request => request.referer === player.address + '/'), 'Embed mengirim identitas origin melalui Referer');
  assert.equal(await page.locator('.rj-youtube-fallback').isVisible(), false, 'Fallback tidak menutupi iframe aktif');

  // A future program changes the downloaded manifest, but not the program on
  // screen. Keep the current embed alive across real manifest refreshes.
  const activeGeneration = player.manifest.generation;
  await page.evaluate(() => {
    window.__activeYoutubeForManifestTest = { player: window.__ytMock.last(), frame: document.querySelector('.rj-widget-youtube iframe'), count: window.__ytMock.instances.length };
  });
  const futureLayout = await (await api('/api/layouts', { method: 'POST', json: { name: 'QA jadwal esok hari', widgets: [
    { id: 'future-text', type: 'text', x: 20, y: 20, width: 1000, height: 200, text: 'Program esok hari belum tayang' },
  ] } })).json();
  const futureStart = Date.now() + 86400000;
  const changedManifestResponse = page.waitForResponse(async response => response.url() === player.address + '/api/local/manifest'
    && response.ok() && (await response.json()).generation !== activeGeneration);
  const futureSchedule = await (await api('/api/schedules', { method: 'POST', json: {
    name: 'QA jadwal mendatang tidak memuat ulang live', layoutId: futureLayout.id, playerIds: [paired.id],
    startAt: new Date(futureStart).toISOString(), endAt: new Date(futureStart + 60000).toISOString(), repeat: 'once', enabled: true,
  } })).json();
  await until(() => player.manifest?.schedules.some(item => item.id === futureSchedule.id), 'Jadwal esok hari belum masuk cache');
  assert.notEqual(player.manifest.generation, activeGeneration, 'Jadwal mendatang mengubah manifest lengkap');
  await changedManifestResponse;
  await page.waitForTimeout(2500);
  const assertActiveEmbedPreserved = async message => assert.deepEqual(await page.evaluate(() => ({
    samePlayer: window.__ytMock.last() === window.__activeYoutubeForManifestTest.player,
    sameFrame: document.querySelector('.rj-widget-youtube iframe') === window.__activeYoutubeForManifestTest.frame,
    destroyed: window.__activeYoutubeForManifestTest.player.destroyed,
    instances: window.__ytMock.instances.length - window.__activeYoutubeForManifestTest.count,
  })), { samePlayer: true, sameFrame: true, destroyed: false, instances: 0 }, message);
  await assertActiveEmbedPreserved('Jadwal mendatang mempertahankan instance dan iframe live yang sedang tayang');
  await player.sync();
  await page.waitForTimeout(2500);
  await assertActiveEmbedPreserved('Sinkronisasi ulang manifest yang sama tidak memuat ulang live');
  assert.equal(await page.getByText('Program esok hari belum tayang', { exact: true }).count(), 0);

  await page.evaluate(() => window.__ytMock.emit('onError', 101));
  await page.locator('.rj-youtube-fallback img').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('.rj-youtube-fallback img')?.naturalWidth === 1);
  assert.match(await page.locator('.rj-youtube-fallback img').getAttribute('src'), /\/media\/.+\/file$/);

  // Reload restores a healthy endless live mock. No ENDED event is emitted before
  // publishing the next layout, so a video-boundary wait would make this fail.
  await page.reload();
  await page.waitForFunction(() => window.__ytMock?.last()?.state === 1);
  const next = await (await api('/api/layouts', { method: 'POST', json: { name: 'QA sesudah live', widgets: [
    { id: 'after-live', type: 'text', x: 20, y: 20, width: 1000, height: 200, text: 'Publish mengganti siaran live' },
  ] } })).json();
  const switchedAt = Date.now();
  await api('/api/layouts/' + next.id + '/publish', { method: 'POST', json: { playerIds: [paired.id] } });
  await page.getByText('Publish mengganti siaran live', { exact: true }).waitFor({ timeout: 6000 });
  assert.ok(Date.now() - switchedAt < 6000, 'Publish tidak menunggu siaran live berakhir');
  assert.equal(await page.evaluate(() => window.__ytMock.instances.filter(item => !item.destroyed).length), 0, 'Iframe lama dibersihkan setelah publish');

  const publishedAgain = (await (await api('/api/layouts/' + live.id + '/publish', { method: 'POST', json: { playerIds: [paired.id] } })).json()).publication;
  await page.waitForFunction(() => window.__ytMock?.last()?.state === 1);
  const scheduledLayout = await (await api('/api/layouts', { method: 'POST', json: { name: 'QA jadwal sesudah live', widgets: [
    { id: 'scheduled-text', type: 'text', x: 20, y: 20, width: 1000, height: 200, text: 'Jadwal mengganti siaran live' },
  ] } })).json();
  const start = Date.now() + 2500;
  const schedule = await (await api('/api/schedules', { method: 'POST', json: { name: 'QA batas live', layoutId: scheduledLayout.id, playerIds: [paired.id], startAt: new Date(start).toISOString(), endAt: new Date(start + 60000).toISOString(), repeat: 'once', enabled: true } })).json();
  await until(() => player.manifest?.schedules.some(item => item.id === schedule.id), 'Jadwal belum masuk cache');
  await page.getByText('Jadwal mengganti siaran live', { exact: true }).waitFor({ timeout: 9000 });
  assert.ok(Date.now() < start + 6000, 'Jadwal tidak menunggu siaran live berakhir');

  const disabled = await (await api('/api/layouts', { method: 'POST', json: { name: 'QA YouTube nonaktif', widgets: [
    { id: 'youtube-disabled', type: 'youtube', enabled: false, x: 0, y: 0, width: 500, height: 400, youtubeUrl: '' },
    { id: 'disabled-note', type: 'text', x: 10, y: 10, width: 1000, height: 100, text: 'YouTube dinonaktifkan' },
  ] } })).json();
  const disabledPublication = (await (await api('/api/layouts/' + disabled.id + '/publish', { method: 'POST', json: { playerIds: [paired.id] } })).json()).publication;
  await until(() => player.manifest?.defaultPublicationId === disabledPublication.id, 'Program nonaktif belum diterima');
  const isolated = await mockedContext(browser);
  const disabledPage = await isolated.context.newPage();
  await disabledPage.goto(player.address + '/player.html');
  await disabledPage.getByText('YouTube dinonaktifkan', { exact: true }).waitFor();
  assert.equal(await disabledPage.locator('.rj-widget-youtube').count(), 0);
  assert.equal(isolated.requests.api.length, 0, 'YouTube nonaktif tidak memuat API');
  assert.equal(isolated.requests.embeds.length, 0, 'YouTube nonaktif tidak membuat embed');
  await isolated.context.close();

  // Store a live layout last, then restart the real agent after closing the CMS.
  // External YouTube requests are blocked, while local cached files still load.
  const finalPublication = (await (await api('/api/layouts/' + live.id + '/publish', { method: 'POST', json: { playerIds: [paired.id] } })).json()).publication;
  await until(() => player.manifest?.defaultPublicationId === finalPublication.id, 'Manifest live terakhir belum tersimpan');
  assert.notEqual(finalPublication.id, publishedAgain.id);
  await mocked.context.close();
  await player.close(); player = null;
  backend.server.closeAllConnections(); await new Promise(resolve => backend.server.close(resolve)); backend = null;
  player = await createPlayer({ dataDir: playerDirectory, port: 0, config, headless: true, connect: false });
  const offline = await mockedContext(browser, { blockYouTube: true });
  const offlinePage = await offline.context.newPage();
  await offlinePage.goto(player.address + '/player.html');
  await offlinePage.locator('.rj-youtube-fallback img').waitFor({ state: 'visible', timeout: 20000 });
  await offlinePage.waitForFunction(() => document.querySelector('.rj-youtube-fallback img')?.naturalWidth === 1);
  assert.equal(player.manifest.defaultPublicationId, finalPublication.id);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(mocked.requests.blocked, [], 'Test tidak membiarkan permintaan eksternal tak dikenal');
  await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
  await fs.writeFile(path.join(root, 'artifacts', 'youtube-mocked-result.json'), JSON.stringify({
    transport: 'mocked YouTube IFrame API; no real livestream verified', staticEditorNoExternalRequests: true,
    fallbackMediaHashVerified: true, muteAndVolumePassed: true, embedRefererPassed: true,
    embedErrorFallbackPassed: true, futureSchedulePreservesLivePassed: true, repeatedSyncPreservesLivePassed: true,
    immediateLivePublishPassed: true, liveSchedulePassed: true,
    disabledNoExternalRequests: true, offlineColdStartFallbackPassed: true, pageErrors,
  }, null, 2));
});

test('YouTube renderer mocked API: buffering/online preserve iframe, stalled retry and ended/autoplay/destroy cleanup', { timeout: 60000 }, async t => {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(runtimeModules)); }
  const directory = path.join(root, 'tmp', 'youtube-lifecycle-' + randomUUID());
  const backend = await createSignageServer({ dataDir: directory });
  await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
  let browser;
  t.after(async () => {
    await browser?.close(); backend.server.closeAllConnections(); await new Promise(resolve => backend.server.close(resolve));
    assert.ok(path.resolve(directory).startsWith(path.join(root, 'tmp') + path.sep));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const base = 'http://127.0.0.1:' + backend.server.address().port;
  browser = await chromium.launch({ ...(process.env.RJ_BROWSER_EXECUTABLE ? { executablePath: process.env.RJ_BROWSER_EXECUTABLE } : {}), headless: true });
  const mocked = await mockedContext(browser);
  await mocked.context.route(base + '/youtube-lifecycle.html', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Isolated YouTube renderer lifecycle</title><div id="host" style="width:1280px;height:720px;position:relative"></div>' }));
  const page = await mocked.context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/youtube-lifecycle.html');
  await page.clock.install();
  await page.evaluate(async id => {
    const { mountRenderer } = await import('/shared/renderer.mjs');
    window.__mountYouTubeTest = (youtubeTiming = {}) => mountRenderer(document.querySelector('#host'), { width: 1280, height: 720, widgets: [
      { id: 'yt-lifecycle', type: 'youtube', enabled: true, x: 0, y: 0, width: 1280, height: 720, youtubeUrl: 'https://www.youtube.com/watch?v=' + id, youtubeVideoId: id, muted: false, volume: 0.6 },
    ] }, { youtubeTiming });
    window.__shortYouTubeTiming = { apiTimeoutMs: 1000, startupTimeoutMs: 1000, bufferTimeoutMs: 1000, retryMs: 150 };
    window.__youtubeRenderer = window.__mountYouTubeTest();
  }, videoId);
  await page.waitForFunction(() => window.__ytMock?.last()?.state === 1);
  assert.equal(await page.evaluate(() => window.__ytMock.last().muted), false);
  assert.equal(await page.evaluate(() => window.__ytMock.last().volume), 60);
  await page.evaluate(() => {
    window.__bufferingYoutube = { player: window.__ytMock.last(), frame: document.querySelector('.rj-widget-youtube iframe'), count: window.__ytMock.instances.length };
    window.__ytMock.emit('onStateChange', 3);
    for (let index = 0; index < 3; index++) window.dispatchEvent(new Event('online'));
  });
  await page.clock.fastForward(20000);
  const assertBufferingEmbedPreserved = async message => assert.deepEqual(await page.evaluate(() => ({
    samePlayer: window.__ytMock.last() === window.__bufferingYoutube.player,
    sameFrame: document.querySelector('.rj-widget-youtube iframe') === window.__bufferingYoutube.frame,
    destroyed: window.__bufferingYoutube.player.destroyed,
    instances: window.__ytMock.instances.length - window.__bufferingYoutube.count,
    fallback: Boolean(document.querySelector('.rj-youtube-fallback')),
  })), { samePlayer: true, sameFrame: true, destroyed: false, instances: 0, fallback: false }, message);
  await assertBufferingEmbedPreserved('Buffering 20 detik dan notifikasi online mempertahankan iframe dengan tenggang bawaan');
  await page.evaluate(() => {
    window.__ytMock.emit('onStateChange', 1);
    for (let index = 0; index < 3; index++) window.dispatchEvent(new Event('online'));
  });
  await page.clock.fastForward(45000);
  await assertBufferingEmbedPreserved('Playing membatalkan timer buffering dan notifikasi online tidak memulai ulang iframe');

  // Short explicit timing keeps the true-stall retry check bounded without
  // weakening the production-default grace period tested above.
  await page.evaluate(() => { window.__youtubeRenderer.destroy(); window.__youtubeRenderer = window.__mountYouTubeTest(window.__shortYouTubeTiming); });
  await page.waitForFunction(() => window.__ytMock?.last()?.state === 1);
  const stalledCount = await page.evaluate(() => window.__ytMock.instances.length);
  await page.evaluate(() => window.__ytMock.emit('onStateChange', 3));
  await page.clock.fastForward(1001);
  await page.locator('.rj-youtube-fallback').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.rj-widget-youtube').getAttribute('data-youtube-reason'), 'buffering');
  await page.clock.fastForward(200);
  await page.waitForFunction(count => window.__ytMock.instances.length > count && window.__ytMock.last()?.state === 1, stalledCount);
  const firstCount = await page.evaluate(() => window.__ytMock.instances.length);
  await page.evaluate(() => window.__ytMock.emit('onError', 101));
  await page.locator('.rj-youtube-fallback').waitFor({ state: 'visible' });
  await page.waitForFunction(count => window.__ytMock.instances.length > count && window.__ytMock.last()?.state === 1, firstCount);
  await page.evaluate(() => window.__ytMock.emit('onAutoplayBlocked'));
  await page.locator('.rj-youtube-fallback').waitFor({ state: 'visible' });
  await page.waitForFunction(() => window.__ytMock.last()?.state === 1);
  await page.evaluate(() => window.__ytMock.emit('onStateChange', 0));
  await page.locator('.rj-youtube-fallback').waitFor({ state: 'visible' });
  const endedCount = await page.evaluate(() => window.__ytMock.instances.length);
  await page.clock.fastForward(31000);
  assert.equal(await page.evaluate(() => window.__ytMock.instances.length), endedCount, 'Live berakhir tidak otomatis memutar arsipnya');
  await page.evaluate(() => { window.__youtubeRenderer.destroy(); window.__youtubeRenderer = window.__mountYouTubeTest(window.__shortYouTubeTiming); });
  await page.waitForFunction(() => window.__ytMock.last()?.state === 1);
  await page.evaluate(() => window.__ytMock.emit('onError', 101));
  await page.locator('.rj-youtube-fallback').waitFor({ state: 'visible' });
  await page.evaluate(() => window.__youtubeRenderer.destroy());
  const destroyedCount = await page.evaluate(() => window.__ytMock.instances.length);
  await page.clock.fastForward(31000);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  assert.equal(await page.evaluate(() => window.__ytMock.instances.length), destroyedCount, 'Destroy membatalkan retry dan online listener');
  assert.equal(await page.locator('iframe').count(), 0);
  assert.equal(await page.locator('.rj-renderer').count(), 0);
  assert.deepEqual(errors, []);
});
