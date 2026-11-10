import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createSignageServer } from '../server/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RJ_PLAYWRIGHT_PATH || 'playwright');

test('Video errors report the actual media code without leaking details and ignore destroyed playback promises', { timeout: 30000 }, async t => {
  const directory = path.join(root, 'tmp', 'video-error-browser-' + randomUUID());
  const backend = await createSignageServer({ dataDir: directory });
  await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + backend.server.address().port;
  let browser;
  t.after(async () => {
    await browser?.close();
    backend.server.closeAllConnections(); await new Promise(resolve => backend.server.close(resolve));
    assert.ok(path.resolve(directory).startsWith(path.join(root, 'tmp') + path.sep));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  browser = await chromium.launch({ ...(process.env.RJ_BROWSER_EXECUTABLE ? { executablePath: process.env.RJ_BROWSER_EXECUTABLE } : {}), headless: true });
  const context = await browser.newContext();
  const setup = await context.request.post(origin + '/api/auth/setup', {
    headers: { 'X-RJ-Request': '1' }, data: { username: 'qa-video-errors', password: randomBytes(24).toString('hex') },
  });
  assert.ok(setup.ok());
  // A real MP4-signature upload deliberately lacks tracks: the browser decoder must reject it.
  const badVideo = Buffer.alloc(64); badVideo.write('ftypisom', 4, 'ascii');
  const upload = await context.request.post(origin + '/api/media', {
    headers: { 'X-RJ-Request': '1', 'X-Filename': 'decoder-fixture.mp4', 'Content-Type': 'video/mp4' }, data: badVideo,
  });
  assert.ok(upload.ok()); const media = await upload.json();
  const page = await context.newPage(), pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(origin);
  await page.evaluate(async source => {
    const { mountRenderer } = await import('/shared/renderer.mjs');
    const host = document.createElement('div'); Object.assign(host.style, { position: 'fixed', width: '640px', height: '360px' }); document.body.append(host);
    window.__videoErrors = [];
    window.__errorRenderer = mountRenderer(host, { width: 640, height: 360, widgets: [{ id: 'broken-video', type: 'video', mediaId: 'fixture', muted: true }] }, {
      mediaUrl: () => source + '?diagnostic-secret=must-not-leak', onError: message => window.__videoErrors.push(message),
    });
  }, media.url);
  await page.waitForFunction(() => window.__videoErrors.some(message => /\(kode [34]\)/.test(message)), null, { timeout: 8000 });
  const errors = await page.evaluate(() => window.__videoErrors);
  assert.ok(errors.some(message => /Video gagal diputar:.*\(kode [34]\)/.test(message)), 'A genuine browser media error includes its media code');
  assert.ok(errors.every(message => !/must-not-leak|diagnostic-secret|\/api\/media\/|https?:/.test(message)), 'Only controlled error text is reported');
  await page.evaluate(() => { window.__errorRenderer.destroy(); });

  const staleErrors = await page.evaluate(async source => {
    const { mountRenderer } = await import('/shared/renderer.mjs');
    const originalPlay = HTMLMediaElement.prototype.play;
    const messages = []; let rejectPlay;
    HTMLMediaElement.prototype.play = function () { return new Promise((resolve, reject) => { rejectPlay = reject; }); };
    try {
      const host = document.createElement('div'); Object.assign(host.style, { width: '640px', height: '360px' }); document.body.append(host);
      const renderer = mountRenderer(host, { width: 640, height: 360, widgets: [{ id: 'old-video', type: 'video', mediaId: 'fixture', muted: true }] }, {
        mediaUrl: () => source, onError: message => messages.push(message),
      });
      renderer.destroy(); host.remove();
      rejectPlay(new DOMException('stale-private-detail-must-not-leak', 'AbortError'));
      await new Promise(resolve => setTimeout(resolve, 30));
      return messages;
    } finally { HTMLMediaElement.prototype.play = originalPlay; }
  }, media.url);
  assert.deepEqual(staleErrors, [], 'An asynchronous rejection from a destroyed renderer cannot overwrite the current playback error');
  assert.deepEqual(pageErrors, []);
});
