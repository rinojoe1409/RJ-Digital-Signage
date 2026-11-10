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

test('Dashboard LAN HTTP: setup dan ID elemen tanpa secure context', { timeout: 60000 }, async t => {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(runtimeModules)); }
  const dataDir = path.join(root, 'tmp', `qa-lan-${crypto.randomUUID()}`);
  const { server } = await createSignageServer({ dataDir });
  let browser;
  t.after(async () => {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.ok(path.resolve(dataDir).startsWith(path.join(root, 'tmp') + path.sep));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://rj-cms.test:${server.address().port}`;
  browser = await chromium.launch({ ...(process.env.RJ_BROWSER_EXECUTABLE ? { executablePath: process.env.RJ_BROWSER_EXECUTABLE } : {}), headless: true, args: [
    '--host-resolver-rules=MAP rj-cms.test 127.0.0.1', '--no-proxy-server',
  ] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  assert.deepEqual(await page.evaluate(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID })), {
    secure: false, uuid: 'undefined',
  }, 'Hostname HTTP biasa benar-benar memakai konteks tidak aman, bukan pengecualian localhost');

  await page.locator('#username').fill('qa-lan');
  await page.locator('#password').fill(crypto.randomBytes(24).toString('base64url'));
  await page.locator('#setupToken').fill((await fs.readFile(path.join(dataDir, 'setup-token'), 'utf8')).trim());
  await page.locator('#auth-form button[type=submit]').click();
  await page.locator('h1', { hasText: 'Ringkasan' }).waitFor();

  await page.locator('[data-action=navigate][data-view=layouts]').click();
  await page.locator('.heading-actions [data-action=new-layout]').click();
  await page.locator('#new-layout-name').fill('QA LAN HTTP');
  await page.locator('#modal-form button[type=submit]').click();
  await page.locator('#canvas-stage').waitFor();
  assert.equal(await page.locator('.widget-outline').count(), 2, 'Dua elemen awal dapat dibuat');
  await page.locator('[data-action=add-widget][data-type=text]').click();
  await page.getByRole('button', { name: 'Duplikasi', exact: true }).click();
  assert.equal(await page.locator('.widget-outline').count(), 4, 'Elemen dapat ditambah dan disalin');
  const saved = page.waitForResponse(response => response.url().includes('/api/layouts/') && response.request().method() === 'PUT');
  await page.locator('[data-action=save-layout]').click();
  const response = await saved;
  assert.equal(response.status(), 200);
  const layout = await response.json();
  assert.equal(layout.widgets.length, 4);
  const ids = layout.widgets.map(widget => widget.id);
  assert.equal(new Set(ids).size, 4);
  for (const widgetId of ids) assert.match(widgetId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(errors, []);
});
