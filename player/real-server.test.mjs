import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { createSignageServer } from '../server/server.mjs';
import { createPlayer } from './agent.mjs';
import { resolveProgram } from '../shared/program.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/wlYAAAAASUVORK5CYII=', 'base64');
const waitFor = async predicate => {
  for (let count = 0; count < 300; count++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Actual server/player delivery did not finish.');
};

test('actual server publishes to actual player via SSE, including cached future schedule', { timeout: 30000 }, async () => {
  const folder = await fs.mkdtemp(path.join(here, '.real-server-test-'));
  let backend, player, cookie = '';
  try {
    backend = await createSignageServer({ dataDir: path.join(folder, 'server') });
    await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
    const serverUrl = `http://127.0.0.1:${backend.server.address().port}`;
    async function admin(route, method = 'GET', body = undefined, extra = {}) {
      const response = await fetch(serverUrl + route, { method, headers: { 'X-RJ-Request': '1', ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra },
        body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      const value = await response.json(); assert.ok(response.ok, `${route}: ${value.error || response.status}`); return value;
    }
    await admin('/api/auth/setup', 'POST', { username: 'integration-admin', password: randomBytes(24).toString('hex') });
    const media = await admin('/api/media', 'POST', png, { 'Content-Type': 'image/png', 'X-Filename': 'integration.png' });
    const draft = await admin('/api/layouts', 'POST', { name: 'Integration active', width: 1920, height: 1080, widgets: [{ id: 'photo', type: 'image', enabled: true, x: 0, y: 0, width: 1920, height: 1080, mediaId: media.id }] });
    const code = await admin('/api/players/pair-code', 'POST', {});
    const paired = await admin('/api/player/pair', 'POST', { code: code.code, name: 'Integration Windows player' });
    const config = { serverUrl, id: paired.id, token: paired.token };
    player = await createPlayer({ dataDir: path.join(folder, 'player'), config, port: 0, headless: true });
    const published = await admin(`/api/layouts/${draft.id}/publish`, 'POST', { playerIds: [paired.id] });
    await waitFor(() => player.manifest?.defaultPublicationId === published.publication.id && player.status.progress === 100);
    const downloaded = Buffer.from(await (await fetch(`${player.address}/media/${media.id}/file`)).arrayBuffer());
    assert.equal(createHash('sha256').update(downloaded).digest('hex'), media.sha256);
    const scheduledDraft = await admin('/api/layouts', 'POST', { name: 'Integration scheduled', widgets: [{ id: 'title', type: 'text', text: 'Terjadwal offline', x: 0, y: 0, width: 1000, height: 200 }] });
    const starts = new Date(Date.now() + 60000), ends = new Date(+starts + 60000);
    const schedule = await admin('/api/schedules', 'POST', { name: 'Offline future', layoutId: scheduledDraft.id, playerIds: [paired.id], startAt: starts.toISOString(), endAt: ends.toISOString(), repeat: 'once', enabled: true });
    await waitFor(() => player.manifest?.schedules.some(item => item.id === schedule.id));
    const generation = player.manifest.generation;
    await player.close(); player = null;
    backend.server.closeAllConnections(); await new Promise(resolve => backend.server.close(resolve)); backend = null;
    player = await createPlayer({ dataDir: path.join(folder, 'player'), config, port: 0, headless: true, connect: false });
    assert.equal(player.manifest.generation, generation);
    assert.equal(resolveProgram(player.manifest, new Date(+starts + 1000)).id, schedule.publicationId);
    assert.equal(resolveProgram(player.manifest, new Date(+ends + 1000)).id, published.publication.id);
  } finally {
    await player?.close();
    if (backend) { backend.server.closeAllConnections(); await new Promise(resolve => backend.server.close(resolve)); }
    assert.ok(folder.startsWith(path.join(here, '.real-server-test-')));
    await fs.rm(folder, { recursive: true, force: true });
  }
});
