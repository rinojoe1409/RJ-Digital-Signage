import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createSignageServer } from '../server/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.RJ_PLAYWRIGHT_PATH || 'playwright');

test('Transfer monitor: automatic publish progress, live status, focus/draft preservation and mobile', { timeout: 90000 }, async t => {
  const directory = path.join(root, 'tmp', 'transfer-browser-' + randomUUID());
  const artifacts = path.join(root, 'artifacts');
  await fs.mkdir(artifacts, { recursive: true });
  const backend = await createSignageServer({ dataDir: directory });
  await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + backend.server.address().port;
  let browser, page;
  const errors = [];
  t.after(async () => {
    t.mock.timers.reset();
    await browser?.close(); backend.server.closeAllConnections(); await new Promise(resolve => backend.server.close(resolve));
    assert.ok(path.resolve(directory).startsWith(path.join(root, 'tmp') + path.sep));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  browser = await chromium.launch({ ...(process.env.RJ_BROWSER_EXECUTABLE ? { executablePath: process.env.RJ_BROWSER_EXECUTABLE } : {}), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, timezoneId: 'Asia/Jakarta' });
  async function api(route, body, { method = body === undefined ? 'GET' : 'POST', token } = {}) {
    const response = await context.request.fetch(origin + route, { method,
      headers: { 'X-RJ-Request': '1', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { data: body }) });
    const value = await response.json(); assert.ok(response.ok(), route + ': ' + (value.error || response.status())); return value;
  }
  await api('/api/auth/setup', { username: 'qa-transfer-ui', password: randomBytes(24).toString('hex') });
  const pair = async name => {
    const { code } = await api('/api/players/pair-code', {});
    return api('/api/player/pair', { code, name });
  };
  const p1 = await pair('PC Lobi'), p2 = await pair('PC Rapat <uji>');
  const oldLayout = await api('/api/layouts', { name: 'Tayangan sebelumnya', widgets: [] });
  const oldPublication = (await api('/api/layouts/' + oldLayout.id + '/publish', { playerIds: [p1.id, p2.id] })).publication;
  const heartbeat = (player, body) => api('/api/player/heartbeat', body, { token: player.token });
  const manifest = player => api('/api/player/manifest', undefined, { token: player.token });
  const oldManifests = new Map();
  for (const player of [p1, p2]) {
    const current = await manifest(player); oldManifests.set(player.id, current);
    await heartbeat(player, { status: 'playing', progress: 100, currentPublicationId: oldPublication.id, downloadedGeneration: current.generation, lastError: '' });
  }
  const layout = await api('/api/layouts', { name: 'Informasi transfer terbaru', widgets: [{ id: 'text', type: 'text', text: 'Informasi baru' }] });
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin); await page.locator('.app-shell').waitFor();
  await page.locator('[data-action=navigate][data-view=layouts]').click();
  const layoutCard = page.locator('.layout-card').filter({ has: page.locator('button[data-action=edit-layout][data-id="' + layout.id + '"]') });
  await layoutCard.locator('button[data-action=edit-layout]').click();
  await page.locator('#canvas-stage').waitFor();
  await page.locator('[data-action=publish-layout]').click();
  for (const player of [p1, p2]) await page.locator('input[name=playerIds][value="' + player.id + '"]').check();
  const publishResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url() === origin + '/api/layouts/' + layout.id + '/publish');
  await page.locator('#modal-form button[type=submit]').click();
  const publication = (await (await publishResponse).json()).publication;
  await page.locator('#transfer-monitor').waitFor();
  const card = player => page.locator('#transfer-monitor .transfer-card[data-transfer-player="' + player.id + '"]');
  const bar = player => card(player).locator('[role=progressbar]');
  assert.equal(await page.locator('#transfer-monitor .transfer-card').count(), 2);
  for (const player of [p1, p2]) assert.equal(await bar(player).getAttribute('aria-valuenow'), null, 'An old 100% heartbeat must not complete a new publish');
  assert.match(await card(p2).innerText(), /PC Rapat <uji>/, 'Player name remains literal text');

  const closeButton = page.locator('#modal .transfer-monitor-footer [data-action=close-modal]');
  await closeButton.focus(); const originalClose = await closeButton.elementHandle();
  await heartbeat(p1, { status: 'downloading', progress: 43, currentPublicationId: oldPublication.id, downloadedGeneration: oldManifests.get(p1.id).generation, lastError: '' });
  await page.waitForFunction(id => document.querySelector('.transfer-card[data-transfer-player="' + id + '"] [role=progressbar]')?.getAttribute('aria-valuenow') === '43', p1.id, { timeout: 7000 });
  assert.equal(await bar(p1).getAttribute('aria-valuemax'), '100');
  assert.equal(await originalClose.evaluate(element => element.isConnected && element === document.activeElement), true, 'Polling must not replace modal controls or move focus');
  await heartbeat(p2, { status: 'cached', progress: 29, currentPublicationId: oldPublication.id, downloadedGeneration: oldManifests.get(p2.id).generation, lastError: 'Jaringan transfer terputus.' });
  await card(p2).getByText('Jaringan transfer terputus.', { exact: false }).waitFor({ timeout: 7000 });
  assert.notEqual(await bar(p2).getAttribute('aria-valuenow'), '100');
  await page.screenshot({ path: path.join(artifacts, 'transfer-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile page must not overflow');
  assert.ok(await page.locator('#modal').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Mobile transfer monitor must not overflow');
  await page.screenshot({ path: path.join(artifacts, 'transfer-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });

  const currentManifest = await manifest(p1);
  await heartbeat(p1, { status: 'ready', progress: 100, currentPublicationId: oldPublication.id, downloadedGeneration: currentManifest.generation, lastError: '' });
  await page.waitForFunction(id => document.querySelector('.transfer-card[data-transfer-player="' + id + '"] [role=progressbar]')?.getAttribute('aria-valuenow') === '100', p1.id, { timeout: 7000 });
  await heartbeat(p1, { status: 'waiting-video', progress: 100, currentPublicationId: oldPublication.id, downloadedGeneration: currentManifest.generation, lastError: '' });
  await card(p1).getByText('Menunggu video selesai', { exact: false }).waitFor({ timeout: 7000 });
  const p2Manifest = await manifest(p2);
  await heartbeat(p2, { status: 'playing', progress: 100, currentPublicationId: publication.id, downloadedGeneration: p2Manifest.generation, lastError: '' });
  await card(p2).getByText('Sedang tayang', { exact: false }).waitFor({ timeout: 7000 });

  await api('/api/layouts/' + layout.id + '/publish', { playerIds: [p1.id] });
  await card(p1).getByText('Penugasan berubah', { exact: false }).waitFor({ timeout: 7000 });
  assert.notEqual(await bar(p1).getAttribute('aria-valuenow'), '100', 'A later publish must not appear complete for the monitored older assignment');
  t.mock.timers.enable({ apis: ['Date'], now: new Date() });
  try {
    t.mock.timers.tick(71000);
    await card(p2).locator('.transfer-phase').filter({ hasText: /offline/i }).waitFor({ timeout: 7000 });
    assert.equal(await bar(p2).getAttribute('aria-valuenow'), null);
  } finally { t.mock.timers.reset(); }
  await heartbeat(p2, { status: 'playing', progress: 100, currentPublicationId: publication.id, downloadedGeneration: p2Manifest.generation, lastError: '' });
  await closeButton.click(); await page.locator('#modal').waitFor({ state: 'hidden' });
  const unsaved = 'Draft belum disimpan saat pemantauan';
  await page.locator('#layout-name').fill(unsaved);
  const refreshWhileEditing = page.waitForResponse(response => response.url() === origin + '/api/state', { timeout: 13000 });
  await refreshWhileEditing;
  assert.equal(await page.locator('#layout-name').inputValue(), unsaved);
  assert.match(await page.locator('[data-save-state]').textContent(), /Belum disimpan/);
  await page.locator('[data-action=close-editor]').click();
  await page.locator('[data-action=discard-editor]').click();
  await page.locator('[data-action=navigate][data-view=players]').click();
  await page.locator('[data-action=player-transfer][data-id="' + p2.id + '"]').click();
  await page.locator('#transfer-monitor').waitFor();
  assert.equal(await page.locator('#transfer-monitor .transfer-card').count(), 1, 'Manual monitoring may be reopened for a selected player');
  await page.locator('#modal .transfer-monitor-footer [data-action=close-modal]').click();
  await page.locator('[data-action=navigate][data-view=layouts]').click();
  await layoutCard.locator('button[data-action=edit-layout]').click();
  await page.locator('[data-action=publish-layout]').click();
  assert.equal(await page.locator('input[name=playerIds]:checked').count(), 0);
  await page.locator('#modal-form button[type=submit]').click();
  await page.locator('#modal').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#transfer-monitor').count(), 0, 'A publish without selected players must not open an empty transfer monitor');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(artifacts, 'transfer-browser-result.json'), JSON.stringify({
    realCmsPublish: true, old100NotReused: true, partialTransferVisible: true, exactGenerationReady: true,
    waitingVideoAndActualPlaybackDistinct: true, targetChangeVisible: true, offlineNotSuccess: true,
    pollPreservesModalFocus: true, pollPreservesDirtyEditor: true, manualMonitorReopens: true,
    noPlayerPublishNoEmptyMonitor: true, mobileNoHorizontalOverflow: true, browserErrors: errors,
  }, null, 2));
});
