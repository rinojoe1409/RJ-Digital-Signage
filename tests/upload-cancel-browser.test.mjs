import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createSignageServer } from '../server/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RJ_PLAYWRIGHT_PATH || 'playwright');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHZkAAAAASUVORK5CYII=', 'base64');

async function until(check, label, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(40);
  }
  assert.fail('Timed out: ' + label);
}

test('Cancel a real throttled media upload, preserve completed files and draft, stop queue and retry', { timeout: 90000 }, async t => {
  const directory = path.join(root, 'tmp', 'upload-cancel-browser-' + randomUUID());
  const artifacts = path.join(root, 'artifacts');
  await fs.mkdir(artifacts, { recursive: true });
  const backend = await createSignageServer({ dataDir: directory });
  await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
  const uploads = [], heldResponses = new Map();
  const proxy = http.createServer((request, response) => {
    const isUpload = request.method === 'POST' && request.url === '/api/media';
    const name = isUpload ? decodeURIComponent(request.headers['x-filename'] || '') : '';
    const record = isUpload ? { name, received: 0, forwarded: 0, aborted: false } : null;
    if (record) uploads.push(record);
    let backendResponse, timer, releaseResponse;
    const upstream = http.request({ hostname: '127.0.0.1', port: backend.server.address().port,
      method: request.method, path: request.url, headers: request.headers }, async received => {
      backendResponse = received;
      if (name === 'committed-before-cancel.png') {
        await new Promise(resolve => { releaseResponse = resolve; heldResponses.set(name, resolve); });
        heldResponses.delete(name);
      }
      if (response.destroyed) { received.destroy(); return; }
      response.writeHead(received.statusCode, received.headers);
      received.pipe(response);
    });
    upstream.on('error', () => { if (!response.destroyed) response.destroy(); });
    const throttle = new Transform({
      transform(chunk, encoding, callback) {
        if (record) record.received += chunk.length;
        const forward = () => { if (record) record.forwarded += chunk.length; callback(null, chunk); };
        if (name === 'slow-active.mp4') timer = setTimeout(forward, 100);
        else forward();
      },
      destroy(error, callback) { clearTimeout(timer); callback(error); },
    });
    request.on('aborted', () => { if (record) record.aborted = true; upstream.destroy(); });
    response.on('close', () => {
      releaseResponse?.();
      if (!response.writableEnded) {
        if (record) record.aborted = true;
        upstream.destroy(); backendResponse?.destroy(); throttle.destroy();
      }
    });
    void pipeline(request, throttle, upstream).catch(() => {});
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + proxy.address().port;
  let browser, page;
  const errors = [], failedUploads = [];
  t.after(async () => {
    if (page) await page.screenshot({ path: path.join(artifacts, 'upload-cancel-last.png'), fullPage: true }).catch(() => {});
    await browser?.close();
    for (const release of heldResponses.values()) release();
    proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
    backend.server.closeAllConnections(); await new Promise(resolve => backend.server.close(resolve));
    assert.ok(path.resolve(directory).startsWith(path.join(root, 'tmp') + path.sep));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  browser = await chromium.launch({ ...(process.env.RJ_BROWSER_EXECUTABLE ? { executablePath: process.env.RJ_BROWSER_EXECUTABLE } : {}), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, timezoneId: 'Asia/Jakarta' });
  async function api(route, body) {
    const response = await context.request.fetch(origin + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-RJ-Request': '1' }, ...(body === undefined ? {} : { data: body }) });
    const value = await response.json(); assert.ok(response.ok(), route + ': ' + (value.error || response.status())); return value;
  }
  await api('/api/auth/setup', { username: 'qa-upload-cancel', password: randomBytes(24).toString('hex') });
  const layout = await api('/api/layouts', { name: 'Protected draft', widgets: [] });
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => { if (request.method() === 'POST' && request.url() === origin + '/api/media') failedUploads.push(request.headers()['x-filename']); });
  await page.goto(origin); await page.locator('.app-shell').waitFor();
  const navigate = view => page.locator('[data-action=navigate][data-view=' + view + ']').click();
  await navigate('media');
  // The fixture has an MP4 container signature; this test exercises upload transport, not video decoding.
  const slowVideo = Buffer.alloc(20 * 1024 * 1024); slowVideo.write('ftyp', 4, 'ascii');
  await page.locator('#media-upload').setInputFiles([
    { name: 'completed-first.png', mimeType: 'image/png', buffer: png },
    { name: 'slow-active.mp4', mimeType: 'video/mp4', buffer: slowVideo },
    { name: 'queued-never-uploaded.png', mimeType: 'image/png', buffer: png },
  ]);
  await until(() => uploads.some(item => item.name === 'slow-active.mp4' && item.forwarded >= 65536), 'real request bytes reach the upload server');
  await page.locator('#upload-progress').waitFor({ state: 'visible' });
  const cancel = page.getByRole('button', { name: 'Batalkan unggahan', exact: true });
  assert.equal(await cancel.count(), 1);
  assert.match(await page.locator('#upload-name').innerText(), /slow-active\.mp4/);
  assert.notEqual(await page.locator('#upload-percent').innerText(), '100%', '100% must wait for server acceptance');

  await page.locator('#page-search').fill('slow');
  assert.equal(await cancel.isVisible(), true, 'A Media search rerender preserves active upload controls');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Upload banner fits a mobile viewport');
  await page.screenshot({ path: path.join(artifacts, 'upload-cancel-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  await navigate('layouts');
  await page.locator('button[data-action=edit-layout][data-id="' + layout.id + '"]').click();
  await page.locator('#layout-name').fill('Unsaved draft survives upload cancellation');
  assert.equal(await cancel.isVisible(), true, 'Cancel remains available away from Media');
  await page.screenshot({ path: path.join(artifacts, 'upload-cancel-desktop.png'), fullPage: true });
  await cancel.click();
  await page.locator('.toast').filter({ hasText: /Unggahan dibatalkan/i }).waitFor();
  await until(() => uploads.find(item => item.name === 'slow-active.mp4')?.aborted, 'Cancel aborts the active HTTP upload');
  await until(() => failedUploads.includes('slow-active.mp4'), 'The browser aborts its XHR');
  await until(async () => !(await fs.readdir(path.join(directory, 'media'))).some(name => name.endsWith('.part')), 'Partial media is cleaned up');
  const afterCancel = await api('/api/state');
  assert.deepEqual(afterCancel.media.filter(item => item.id !== 'brand-rj-approved').map(item => item.name), ['completed-first.png']);
  assert.equal(uploads.some(item => item.name === 'queued-never-uploaded.png'), false, 'Cancel stops remaining files in the selected batch');
  assert.equal(await page.locator('#layout-name').inputValue(), 'Unsaved draft survives upload cancellation');
  assert.match(await page.locator('[data-save-state]').innerText(), /Belum disimpan/);
  assert.equal(await page.locator('.toast.error').count(), 0, 'A requested abort is not reported as a network failure');

  await navigate('media'); await page.locator('[data-action=discard-editor]').click();
  await page.locator('#page-search').fill('');
  await page.locator('#media-upload').setInputFiles({ name: 'retry-after-cancel.png', mimeType: 'image/png', buffer: png });
  await page.locator('.toast').filter({ hasText: /retry-after-cancel\.png berhasil diunggah/i }).waitFor();
  await until(async () => (await api('/api/state')).media.some(item => item.name === 'retry-after-cancel.png'), 'A new upload can succeed after cancellation');
  await cancel.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.toast.error').count(), 0);

  // Cancellation after commit must never delete a file which the server has already accepted.
  await page.locator('#media-upload').setInputFiles({ name: 'committed-before-cancel.png', mimeType: 'image/png', buffer: png });
  await until(() => heldResponses.has('committed-before-cancel.png'), 'The proxy holds a successful response');
  await until(async () => (await api('/api/state')).media.some(item => item.name === 'committed-before-cancel.png'), 'The final upload has committed before cancel');
  assert.notEqual(await page.locator('#upload-percent').innerText(), '100%');
  await cancel.click();
  await cancel.waitFor({ state: 'hidden' });
  await until(async () => (await api('/api/state')).media.filter(item => item.id !== 'brand-rj-approved').length === 3, 'Committed uploads remain in the library');
  assert.equal(await page.locator('.toast.error').count(), 0);
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(artifacts, 'upload-cancel-browser-result.json'), JSON.stringify({
    realThrottledUploadAborted: true, remainingQueueStopped: true, priorCompletedFileRetained: true,
    partialFileCleaned: true, retrySucceeded: true, committedFileRetainedAfterLateCancel: true,
    navigationAndSearchPreserveCancel: true, dirtyDraftPreserved: true, mobileNoHorizontalOverflow: true,
    intentionalAbortNotError: true, browserErrors: errors,
  }, null, 2));
});
