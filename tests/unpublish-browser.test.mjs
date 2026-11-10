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
const playwrightPath = process.env.RJ_PLAYWRIGHT_PATH || 'playwright';

test('Batalkan terbit: real dashboard confirmation, stale usage, dirty draft, delete, retained schedule and mobile', { timeout: 90000 }, async t => {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(playwrightPath)); }
  const dataDir = path.join(root, 'tmp', 'unpublish-browser-' + randomUUID());
  const artifacts = path.join(root, 'artifacts');
  await fs.mkdir(artifacts, { recursive: true });
  const backend = await createSignageServer({ dataDir });
  await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + backend.server.address().port;
  let browser, page;
  const errors = [], unpublishRequests = [];
  t.after(async () => {
    await page?.screenshot({ path: path.join(artifacts, 'unpublish-last-state.png'), fullPage: true }).catch(() => {});
    await browser?.close();
    backend.server.closeAllConnections(); await new Promise(resolve => backend.server.close(resolve));
    assert.ok(path.resolve(dataDir).startsWith(path.join(root, 'tmp') + path.sep));
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });
  browser = await chromium.launch({ ...(process.env.RJ_BROWSER_EXECUTABLE ? { executablePath: process.env.RJ_BROWSER_EXECUTABLE } : {}), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, timezoneId: 'Asia/Jakarta' });
  async function api(route, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await context.request.fetch(origin + route, { method, headers: { 'X-RJ-Request': '1' }, ...(body === undefined ? {} : { data: body }) });
    const result = await response.json();
    assert.ok(response.ok(), `${method} ${route}: ${response.status()} ${result.error || ''}`);
    return result;
  }
  await api('/api/auth/setup', { username: 'qa-unpublish-ui', password: randomBytes(24).toString('base64url') });
  async function pair(name) {
    const code = await api('/api/players/pair-code', {});
    return api('/api/player/pair', { code: code.code, name });
  }
  const online = await pair('PC Ruang Uji');
  const offline = await pair('PC Offline Uji');
  const layout = await api('/api/layouts', { name: 'Informasi <uji aman>', width: 1280, height: 720, widgets: [
    { id: 'test-image', type: 'image', mediaId: 'brand-rj-approved', x: 0, y: 0, width: 1280, height: 720 },
  ] });
  await api('/api/layouts/' + layout.id + '/publish', { playerIds: [online.id, offline.id] });
  const start = Date.now() + 86400000;
  const schedule = await api('/api/schedules', { name: 'Jadwal esok hari <uji>', layoutId: layout.id,
    playerIds: [online.id, offline.id], enabled: true, startAt: new Date(start).toISOString(), endAt: new Date(start + 3600000).toISOString(), repeat: 'once' });
  await api('/api/players/' + offline.id + '/action', { action: 'revoke' });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'POST' && request.url() === origin + '/api/layouts/' + layout.id + '/unpublish') unpublishRequests.push(request);
  });
  await page.goto(origin);
  await page.locator('h1', { hasText: 'Ringkasan' }).waitFor();
  await page.locator('[data-action=navigate][data-view=layouts]').click();
  const card = page.locator('.layout-card').filter({ has: page.locator('[data-action=edit-layout][data-id="' + layout.id + '"]') });
  await card.locator('[data-action=unpublish-layout]').waitFor({ state: 'visible' });
  assert.match(await card.locator('.layout-label').textContent(), /VERSI TERBIT/);

  // Deleting a published draft points to the actual unpublish action rather
  // than submitting a delete that can only fail.
  await card.locator('[data-action=delete-layout]').click();
  await page.getByRole('heading', { name: 'Batalkan terbit terlebih dahulu', exact: true }).waitFor();
  assert.equal(await page.locator('#modal button[type=submit]').count(), 0);
  await page.locator('#modal [data-action=unpublish-layout]').click();
  await page.getByRole('heading', { name: 'Batalkan terbit layout?', exact: true }).waitFor();
  assert.match(await page.locator('#modal').innerText(), /PC Ruang Uji/);
  assert.match(await page.locator('#modal').innerText(), /PC Offline Uji/);
  assert.match(await page.locator('#modal').innerText(), /Jadwal esok hari <uji>/);
  assert.match(await page.locator('#modal').innerText(), /Player offline baru menerima perubahan setelah tersambung/);
  assert.match(await page.locator('#modal').innerText(), /Draft dan media tetap tersimpan/);
  assert.match(await page.locator('#modal').innerText(), /Video file menyelesaikan pemutaran/);
  await page.locator('#modal .modal-footer [data-action=close-modal]').click();
  assert.equal(unpublishRequests.length, 0, 'Cancel must not stop publishing');
  assert.ok((await api('/api/state')).publications.filter(pub => pub.layoutId === layout.id).every(pub => !pub.withdrawnAt));

  // The editor action preserves unsaved draft changes while withdrawing only
  // immutable published versions.
  await card.locator('button[data-action=edit-layout]').click();
  await page.locator('#canvas-stage').waitFor();
  const unsavedName = 'Perubahan draft belum disimpan';
  await page.locator('#layout-name').fill(unsavedName);
  assert.match(await page.locator('[data-save-state]').textContent(), /Belum disimpan/);
  await page.locator('.editor-heading [data-action=unpublish-layout]').click();
  await page.getByRole('heading', { name: 'Batalkan terbit layout?', exact: true }).waitFor();
  assert.match(await page.locator('#modal').innerText(), /Perubahan draft yang belum disimpan tetap berada di editor/);
  await page.screenshot({ path: path.join(artifacts, 'unpublish-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile page must not overflow horizontally');
  assert.ok(await page.locator('#modal').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Mobile confirmation must not overflow horizontally');
  await page.screenshot({ path: path.join(artifacts, 'unpublish-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });

  // A second admin publishes while the confirmation is open. The first click
  // must refresh the impact and require another explicit click, never retry it.
  await api('/api/layouts/' + layout.id + '/publish', { playerIds: [online.id] });
  const staleResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/' + layout.id + '/unpublish'));
  await page.locator('#modal-form button[type=submit]').click();
  assert.equal((await staleResponse).status(), 409);
  await page.locator('#modal .notice.warning').filter({ hasText: 'Pemakaian layout berubah' }).waitFor();
  assert.equal(unpublishRequests.length, 1, 'Stale confirmation must not automatically post again');
  assert.ok((await api('/api/state')).publications.filter(pub => pub.layoutId === layout.id).every(pub => !pub.withdrawnAt));
  const completed = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/' + layout.id + '/unpublish'));
  await page.locator('#modal-form button[type=submit]').click();
  assert.equal((await completed).status(), 200);
  await page.locator('#modal').waitFor({ state: 'hidden' });
  await page.locator('.editor-heading [data-action=unpublish-layout]').waitFor({ state: 'detached' });
  assert.equal(await page.locator('#layout-name').inputValue(), unsavedName);
  assert.match(await page.locator('[data-save-state]').textContent(), /Belum disimpan/);
  let state = await api('/api/state');
  assert.equal(state.layouts.find(item => item.id === layout.id).name, layout.name);
  assert.ok(state.publications.filter(pub => pub.layoutId === layout.id).every(pub => pub.withdrawnAt));
  assert.equal(state.schedules.find(item => item.id === schedule.id).enabled, false);
  assert.ok(state.media.some(item => item.id === 'brand-rj-approved'));

  await page.locator('[data-action=close-editor]').click();
  await page.getByRole('heading', { name: 'Simpan perubahan?', exact: true }).waitFor();
  await page.locator('[data-action=discard-editor]').click();
  await card.locator('.layout-label').waitFor();
  assert.equal((await card.locator('.layout-label').textContent()).trim(), 'DRAFT');
  assert.equal(await card.locator('[data-action=unpublish-layout]').count(), 0);
  await card.locator('[data-action=delete-layout]').click();
  await page.getByRole('heading', { name: 'Hapus layout?', exact: true }).waitFor();
  await page.locator('#modal-form button[type=submit]').click();
  await card.waitFor({ state: 'detached' });
  state = await api('/api/state');
  assert.equal(state.layouts.some(item => item.id === layout.id), false);
  assert.equal(state.schedules.find(item => item.id === schedule.id).enabled, false);
  assert.ok(state.publications.filter(pub => pub.layoutId === layout.id).every(pub => pub.withdrawnAt));
  assert.ok(state.players.every(player => !state.publications.some(pub => pub.layoutId === layout.id && pub.id === player.defaultPublicationId)));

  // A retained disabled schedule cannot silently pick an unrelated first draft
  // after its source draft was deleted.
  await page.locator('[data-action=navigate][data-view=schedules]').click();
  await page.locator('[data-action=edit-schedule][data-id="' + schedule.id + '"]').click();
  await page.locator('#schedule-layout').waitFor();
  assert.equal(await page.locator('#schedule-layout').inputValue(), '');
  assert.equal(await page.locator('#schedule-layout option:checked').textContent(), 'Pilih layout pengganti');
  assert.equal(await page.locator('input[name=enabled]').isChecked(), false);
  assert.equal(await page.locator('#schedule-layout').evaluate(element => element.checkValidity()), false);
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(artifacts, 'unpublish-browser-result.json'), JSON.stringify({
    actualCms: true, publishedDeleteGuidance: true, cancelNoMutation: true, affectedPlayersAndSchedules: true,
    staleConfirmationRequiresSecondClick: true, dirtyDraftPreserved: true, draftDeletionPassed: true,
    retainedScheduleReplacementRequired: true, mobileNoHorizontalOverflow: true, browserErrors: errors,
  }, null, 2));
});
