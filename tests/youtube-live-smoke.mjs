// Explicit opt-in real-network smoke check; never part of the offline unit-test suite.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { createSignageServer } from '../server/server.mjs';
import { createPlayer } from '../player/agent.mjs';
import { normalizeYouTubeUrl } from '../shared/youtube.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const normalized = normalizeYouTubeUrl(process.env.RJ_YOUTUBE_URL);
const soakMs = Number(process.env.RJ_LIVE_SOAK_MS || 120000);
assert.ok(Number.isFinite(soakMs) && soakMs >= 10000 && soakMs <= 3600000, 'RJ_LIVE_SOAK_MS must be between 10000 and 3600000.');
const artifactPrefix = process.env.RJ_LIVE_ARTIFACT_PREFIX || 'youtube-live';
assert.match(artifactPrefix, /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/, 'Use a filename prefix without paths.');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RJ_PLAYWRIGHT_PATH || 'playwright');
const directory = path.join(root, 'tmp', 'youtube-real-' + randomUUID());
let backend, player, browser;
const result = { url: normalized.url, realNetwork: true, requestedSoakMs: soakMs, verifiedPlayback: false, verifiedSoak: false, states: [], samples: [], requestFailures: [], browserErrors: [] };
try {
  backend = await createSignageServer({ dataDir: path.join(directory, 'cms') });
  await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + backend.server.address().port;
  let cookie = '';
  async function api(route, body) {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-RJ-Request': '1', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const value = await response.json(); assert.ok(response.ok, value.error || route); return value;
  }
  await api('/api/auth/setup', { username: 'qa-live', password: randomBytes(24).toString('hex') });
  const code = await api('/api/players/pair-code', {});
  const paired = await api('/api/player/pair', { code: code.code, name: 'QA live isolated' });
  const layout = await api('/api/layouts', { name: 'YouTube user link isolated check', width: 1280, height: 720, widgets: [
    { id: 'real-live', type: 'youtube', youtubeUrl: normalized.url, fallbackMediaId: 'brand-rj-approved', x: 0, y: 0, width: 1280, height: 720, muted: true, volume: 1 },
  ] });
  await api('/api/layouts/' + layout.id + '/publish', { playerIds: [paired.id] });
  player = await createPlayer({ dataDir: path.join(directory, 'player'), port: 0, config: { serverUrl: base, id: paired.id, token: paired.token }, headless: true });
  await player.sync();
  browser = await chromium.launch({ ...(process.env.RJ_BROWSER_EXECUTABLE ? { executablePath: process.env.RJ_BROWSER_EXECUTABLE } : {}), headless: process.env.RJ_LIVE_VISIBLE !== '1', args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(1000);
  // Record DOM identity independently of the renderer. Polling alone can miss a
  // brief fallback or a removed/recreated iframe between two video samples.
  await page.addInitScript(() => {
    const probe = window.__rjLiveProbe = { created: 0, removed: 0, sourceChanges: 0, events: [] };
    const identities = new WeakMap();
    const record = event => { if (probe.events.length < 1000) probe.events.push({ at: Date.now(), ...event }); };
    const framesWithin = node => node.nodeType === 1 ? [...(node.tagName === 'IFRAME' ? [node] : []), ...node.querySelectorAll('iframe')]
      .filter(frame => identities.has(frame) || frame.matches('.rj-widget-youtube iframe')) : [];
    const observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) for (const frame of framesWithin(node)) {
          if (identities.has(frame)) continue;
          identities.set(frame, ++probe.created); frame.dataset.rjProbeId = String(probe.created);
          record({ event: 'iframe-added', identity: probe.created, id: frame.id });
        }
        for (const node of mutation.removedNodes) for (const frame of framesWithin(node)) {
          probe.removed++; record({ event: 'iframe-removed', identity: identities.get(frame), id: frame.id });
        }
        if (mutation.type === 'attributes' && mutation.attributeName === 'src' && mutation.target.matches('.rj-widget-youtube iframe')) {
          probe.sourceChanges++; record({ event: 'iframe-source-changed', identity: identities.get(mutation.target), id: mutation.target.id });
        }
        if (mutation.type === 'attributes' && mutation.attributeName === 'data-youtube-state') {
          record({ event: 'state', state: mutation.target.dataset.youtubeState, reason: mutation.target.dataset.youtubeReason });
        }
      }
    });
    observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'data-youtube-state'] });
  });
  page.on('pageerror', error => result.browserErrors.push(error.message));
  page.on('requestfailed', request => {
    if (result.requestFailures.length >= 20) return;
    const url = new URL(request.url());
    result.requestFailures.push({ origin: url.origin, path: url.pathname, error: request.failure()?.errorText });
  });
  await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
  await page.goto(player.address + '/player.html', { waitUntil: 'domcontentloaded', timeout: 20000 });
  const testStarted = Date.now(), startupDeadline = testStarted + 60000;
  let soakStarted = null, stableIdentity = null, startProbe = null, previousVideo = null;
  let advancedSeconds = 0, progressingSamples = 0, stalledSince = null, failure = '';
  while (Date.now() < (soakStarted === null ? startupDeadline : soakStarted + soakMs)) {
    const at = Date.now();
    const snapshot = await page.locator('.rj-widget-youtube').evaluate(element => ({
      state: element.dataset.youtubeState, reason: element.dataset.youtubeReason,
      iframeId: element.querySelector('iframe')?.id || null, identity: element.querySelector('iframe')?.dataset.rjProbeId || null,
    })).catch(() => null);
    const previousState = result.states.at(-1);
    if (snapshot && (!previousState || previousState.state !== snapshot.state || previousState.reason !== snapshot.reason || previousState.identity !== snapshot.identity)) {
      result.states.push({ at: new Date(at).toISOString(), elapsedMs: at - testStarted, ...snapshot });
    }
    const frame = page.frames().find(item => item.url().startsWith('https://www.youtube-nocookie.com/embed/'));
    const video = frame ? await frame.locator('video').first().evaluate(element => ({
      time: element.currentTime, width: element.videoWidth, paused: element.paused, readyState: element.readyState,
    })).catch(() => null) : null;
    if (snapshot?.state === 'playing' && video?.width > 0 && !video.paused) {
      if (previousVideo && previousVideo.identity === snapshot.identity && video.time > previousVideo.time + 0.05) {
        const advancement = video.time - previousVideo.time;
        // A discontinuity/DVR jump is not evidence of continuous decoded video.
        if (advancement <= Math.max(5, (at - previousVideo.at) / 1000 * 3)) {
          advancedSeconds += advancement; progressingSamples++; stalledSince = null;
          if (soakStarted === null) {
            soakStarted = at; stableIdentity = snapshot.identity;
            startProbe = await page.evaluate(() => ({ created: window.__rjLiveProbe.created, removed: window.__rjLiveProbe.removed, sourceChanges: window.__rjLiveProbe.sourceChanges }));
            result.verifiedPlayback = true; result.soakStartedAt = new Date(at).toISOString();
          }
        }
      }
    }
    previousVideo = video ? { at, identity: snapshot?.identity, time: video.time } : null;
    result.samples.push({ at: new Date(at).toISOString(), elapsedMs: at - testStarted, state: snapshot?.state || 'missing', identity: snapshot?.identity || null, video });
    if (soakStarted !== null) {
      const probe = await page.evaluate(start => ({ created: window.__rjLiveProbe.created, removed: window.__rjLiveProbe.removed, sourceChanges: window.__rjLiveProbe.sourceChanges,
        fallbackAfterStart: window.__rjLiveProbe.events.some(event => event.at >= start && event.event === 'state' && event.state === 'fallback') }), soakStarted);
      if (snapshot?.identity !== stableIdentity || probe.created !== startProbe.created || probe.removed !== startProbe.removed || probe.sourceChanges !== startProbe.sourceChanges) failure ||= 'YouTube iframe was replaced, removed or navigated after playback began.';
      if (snapshot?.state === 'fallback' || probe.fallbackAfterStart) failure ||= 'YouTube entered fallback after playback began.';
      stalledSince ??= at;
      if (at - stalledSince > 15000) failure ||= 'No decoded video progress for more than 15 seconds during the soak.';
      if (failure) break;
    }
    await page.waitForTimeout(500);
  }
  result.observedSoakMs = soakStarted === null ? 0 : Date.now() - soakStarted;
  result.video = { advancedSeconds, progressingSamples };
  result.iframeProbe = await page.evaluate(() => window.__rjLiveProbe);
  result.lastError = (await (await fetch(player.address + '/api/local/status')).json()).lastError;
  await page.screenshot({ path: path.join(root, 'artifacts', artifactPrefix + '-user-link.png') });
  assert.ok(result.verifiedPlayback, 'Live did not begin decoding within 60 seconds.');
  assert.equal(failure, '', failure);
  assert.ok(result.observedSoakMs >= soakMs, 'The requested soak did not finish.');
  assert.ok(advancedSeconds >= soakMs / 1000 * 0.7, 'Decoded video did not advance for at least 70% of the soak duration.');
  assert.ok(progressingSamples >= Math.floor(soakMs / 1000), 'Too few independent decoded-progress samples.');
  assert.deepEqual(result.browserErrors, [], 'Browser script errors occurred.');
  result.verifiedSoak = true;
} catch (error) { result.error = error.message; }
finally {
  for (const [name, close] of [
    ['browser', () => browser?.close()], ['player', () => player?.close()],
    ['cms', async () => { if (backend) { backend.server.closeAllConnections(); await new Promise(resolve => backend.server.close(resolve)); } }],
  ]) {
    try { await close(); } catch (error) { (result.cleanupErrors ||= []).push(name + ': ' + error.message); }
  }
  await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
  await fs.writeFile(path.join(root, 'artifacts', artifactPrefix + '-result.json'), JSON.stringify(result, null, 2));
  assert.ok(directory.startsWith(path.join(root, 'tmp') + path.sep));
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
console.log(JSON.stringify(result));
if (!result.verifiedSoak) process.exitCode = 1;
