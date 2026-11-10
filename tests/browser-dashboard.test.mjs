import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createSignageServer } from '../server/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const runtimeModules = process.env.RJ_PLAYWRIGHT_PATH || 'playwright';

test('Dashboard nyata: setup, editor, media, publish, jadwal, pengaturan, dan mobile', { timeout: 150000 }, async t => {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(runtimeModules)); }
  const dataDir = path.join(root, 'tmp', `qa-dashboard-${crypto.randomUUID()}`);
  const qaDir = path.join(root, 'artifacts', 'qa-dashboard');
  await fs.mkdir(qaDir, { recursive: true });
  const { server } = await createSignageServer({ dataDir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ ...(process.env.RJ_BROWSER_EXECUTABLE ? { executablePath: process.env.RJ_BROWSER_EXECUTABLE } : {}), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, timezoneId: 'Asia/Jakarta' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const username = 'qa-dashboard';
  const password = crypto.randomBytes(24).toString('base64url');
  const mutate = { 'X-RJ-Request': '1' };
  t.after(async () => {
    await page.screenshot({ path: path.join(qaDir, '07-last-state.png'), fullPage: true }).catch(() => {});
    await fs.writeFile(path.join(qaDir, 'browser-errors.json'), JSON.stringify({ errors, messages: await page.locator('#toast-region').innerText().catch(() => '') }, null, 2));
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.ok(path.resolve(dataDir).startsWith(path.join(root, 'tmp') + path.sep));
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  await page.goto(origin);
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('#auth-form button[type=submit]').click();
  await page.locator('h1', { hasText: 'Ringkasan' }).waitFor();
  await page.screenshot({ path: path.join(qaDir, '01-dashboard-desktop.png'), fullPage: true });

  for (const view of ['layouts', 'media', 'players', 'schedules', 'settings', 'overview']) {
    await page.locator(`[data-action=navigate][data-view=${view}]`).click();
    await page.locator('#main-content').waitFor();
    assert.equal(await page.locator('.nav-item.active').getAttribute('data-view'), view);
  }

  await page.locator('[data-action=navigate][data-view=layouts]').click();
  await page.locator('.heading-actions [data-action=new-layout]').click();
  await page.locator('#new-layout-name').fill('QA Layout <aman>');
  await page.locator('#modal-form button[type=submit]').click();
  await page.locator('#canvas-stage').waitFor();
  const firstWidget = page.locator('.widget-outline').first();
  await firstWidget.click({ position: { x: 10, y: 10 } });
  let xBefore = Number(await page.locator('#prop-x').inputValue());
  let bounds = await firstWidget.boundingBox();
  await page.mouse.move(bounds.x + 15, bounds.y + 15);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 48, bounds.y + 35, { steps: 5 });
  await page.mouse.up();
  assert.ok(Number(await page.locator('#prop-x').inputValue()) > xBefore, 'Elemen benar-benar bergeser pada koordinat layout');
  const widthBefore = Number(await page.locator('#prop-width').inputValue());
  bounds = await page.locator('.widget-outline.selected .resize-handle').boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 30, bounds.y + 17, { steps: 5 });
  await page.mouse.up();
  assert.ok(Number(await page.locator('#prop-width').inputValue()) > widthBefore, 'Elemen benar-benar dapat di-resize');

  await page.locator('#prop-text').fill('Informasi pengujian lokal <tetap berupa teks>');
  for (const type of ['video', 'ticker', 'prayer']) {
    await page.locator(`[data-action=add-widget][data-type=${type}]`).click();
    const toggle = page.locator('input[data-prop=enabled]');
    await page.locator('label.switch-label').filter({ has: toggle }).click();
    assert.equal(await toggle.isChecked(), false, `${type} dapat dinonaktifkan`);
  }
  const saved = page.waitForResponse(response => response.url().includes('/api/layouts/') && response.request().method() === 'PUT');
  await page.locator('[data-action=save-layout]').click();
  assert.equal((await saved).status(), 200);
  await page.screenshot({ path: path.join(qaDir, '02-editor-desktop.png'), fullPage: true });
  await page.locator('[data-action=preview-editor]').click();
  await page.frameLocator('#preview-modal iframe').locator('.rj-renderer').waitFor();
  await page.locator('#preview-modal [data-action=close-modal]').click();

  await page.locator('[data-action=publish-layout]').click();
  await page.locator('#modal-form button[type=submit]').click();
  await page.locator('#modal').waitFor({ state: 'hidden' });
  await page.locator('[data-action=close-editor]').click();
  await page.locator('[data-action=navigate][data-view=players]').click();
  await page.locator('.heading-actions [data-action=pair-player]').click();
  const code = (await page.locator('.pair-code').textContent()).trim();
  assert.match(code, /^\d{6}$/);
  const paired = await context.request.post(origin + '/api/player/pair', { headers: mutate, data: { code, name: 'QA Windows Player' } });
  assert.equal(paired.status(), 201);
  await page.locator('#modal [data-action=close-modal]').first().click();
  await page.reload();
  await page.locator('h1', { hasText: 'Ringkasan' }).waitFor();

  await page.locator('[data-action=navigate][data-view=media]').click();
  const uploadResponse = page.waitForResponse(response => response.url().endsWith('/api/media') && response.request().method() === 'POST');
  await page.locator('#media-upload').setInputFiles(path.join(root, 'branding', 'RJ-Digital-Signage-System-logo-approved-v1.png'));
  assert.equal((await uploadResponse).status(), 201);
  await page.locator('.media-card', { hasText: 'RJ-Digital-Signage-System-logo-approved-v1.png' }).waitFor();
  await page.screenshot({ path: path.join(qaDir, '03-media-desktop.png'), fullPage: true });

  await page.locator('[data-action=navigate][data-view=schedules]').click();
  await page.locator('.heading-actions [data-action=new-schedule]').click();
  await page.locator('#schedule-name').fill('QA jadwal berulang');
  await page.locator('#schedule-repeat').selectOption('weekly');
  await page.locator('input[name=playerIds]').first().check();
  await page.locator('#modal-form button[type=submit]').click();
  await page.locator('#modal').waitFor({ state: 'hidden' });
  await page.locator('td', { hasText: 'QA jadwal berulang' }).waitFor();

  await page.locator('[data-action=navigate][data-view=settings]').click();
  await page.locator('#locationName').fill('Jakarta QA');
  await page.locator('#adjust-fajr').fill('2');
  const settingsSaved = page.waitForResponse(response => response.url().endsWith('/api/settings') && response.request().method() === 'PUT');
  await page.locator('#settings-form button[type=submit]').click();
  assert.equal((await settingsSaved).status(), 200);
  await page.getByText('Pengaturan disimpan dan dikirim ke player.', { exact: true }).waitFor();
  const timetable = 'date,fajr,dhuhr,asr,maghrib,isha\n2026-11-03,04:12,11:41,15:01,17:52,19:03\n';
  await page.locator('#prayer-import').setInputFiles({ name: 'jadwal-qa.csv', mimeType: 'text/csv', buffer: Buffer.from(timetable) });
  await page.locator('#modal[open]').getByRole('heading', { name: 'Impor jadwal sholat', exact: true }).waitFor();
  await page.locator('#modal-form button[type=submit]').click();
  await page.locator('#modal').waitFor({ state: 'hidden' });
  await page.getByText('1 tanggal tersimpan.', { exact: false }).waitFor();
  const download = page.waitForEvent('download');
  await page.locator('[data-action=backup]').click();
  assert.match((await download).suggestedFilename(), /RJ-Signage-backup/);
  await page.screenshot({ path: path.join(qaDir, '04-settings-desktop.png'), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-action=navigate][data-view=overview]').click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Dashboard tidak melebar keluar layar ponsel');
  await page.screenshot({ path: path.join(qaDir, '05-dashboard-mobile.png'), fullPage: true });
  await page.locator('[data-action=navigate][data-view=layouts]').click();
  await page.locator('.layout-card', { hasText: 'QA Layout <aman>' }).locator('[data-action=edit-layout]').first().click();
  await page.locator('#canvas-stage').waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Editor tidak melebar keluar layar ponsel');
  await page.screenshot({ path: path.join(qaDir, '06-editor-mobile.png'), fullPage: true });
  await page.locator('[data-action=close-editor]').click();
  await page.locator('[data-action=logout]').click();
  await page.locator('#auth-form').waitFor();
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  const relogin = page.waitForResponse(response => response.url().endsWith('/api/auth/login') && response.request().method() === 'POST');
  await page.locator('#auth-form button[type=submit]').click();
  assert.equal((await relogin).status(), 200);
  await page.locator('.app-shell').waitFor();
  assert.equal(await page.locator('.account-name').textContent(), username);
  assert.deepEqual(errors, [], 'Tidak ada error JavaScript pada alur dashboard');
});
