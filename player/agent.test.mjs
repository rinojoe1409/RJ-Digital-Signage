import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createPlayer } from './agent.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const digest = buffer => createHash('sha256').update(buffer).digest('hex');
const waitFor = async callback => {
  for (let count = 0; count < 200; count++) { if (await callback()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Condition did not become true.');
};

test('verified cache is atomic, range works, offline cold start survives and SSE pushes resync', async () => {
  const dataDir = await fs.mkdtemp(path.join(here, '.test-cache-'));
  const bytes = Buffer.from('first complete media file');
  let expectedBytes = bytes, remoteBytes = bytes, generation = 'generation-1';
  const streams = new Set();
  const remote = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer local-test-token');
    if (req.url === '/api/player/manifest') {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ schema: 1, generation, serverTime: new Date().toISOString(), settings: { timezone: 'Asia/Jakarta' }, defaultPublicationId: 'published', programs: [{ id: 'published', layout: { id: 'layout', widgets: [] } }], schedules: [], assets: [{ id: 'asset', mime: 'image/png', size: expectedBytes.length, sha256: digest(expectedBytes) }] }));
    } else if (req.url === '/api/player/media/asset/file') res.end(remoteBytes);
    else if (req.url === '/api/player/heartbeat') { for await (const _chunk of req) { /* consume body */ } res.end('{}'); }
    else if (req.url === '/api/player/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('event: hello\ndata: {}\n\n'); streams.add(res); req.on('close', () => streams.delete(res)); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  const config = { id: 'player-test', token: 'local-test-token', serverUrl: `http://127.0.0.1:${remote.address().port}` };
  let player;
  try {
    player = await createPlayer({ dataDir, config, port: 0, headless: true, connect: false });
    await player.sync(); assert.ok(player.manifest, JSON.stringify(player.status)); assert.equal(player.manifest.generation, 'generation-1');
    const range = await fetch(`${player.address}/media/asset/file`, { headers: { Range: 'bytes=0-4' } });
    assert.equal(range.status, 206); assert.equal(await range.text(), 'first');
    const forbidden = await fetch(`${player.address}/api/local/status`, { method: 'POST', headers: { Origin: 'http://external.test', 'X-RJ-Request': '1' }, body: '{}' });
    assert.equal(forbidden.status, 403);
    generation = 'generation-corrupt';
    expectedBytes = Buffer.from('new complete media file'); remoteBytes = Buffer.from('incomplete');
    await player.sync(); assert.equal(player.manifest.generation, 'generation-1');
    assert.match(player.status.lastError, /Pemeriksaan media/);
    assert.equal(await (await fetch(`${player.address}/media/asset/file`)).text(), bytes.toString());
    remoteBytes = expectedBytes; await player.sync(); assert.equal(player.manifest.generation, 'generation-corrupt');
    await player.close(); player = null;
    // A same-size corrupt cold cache must be detected and repaired even when generation is unchanged.
    await fs.writeFile(path.join(dataDir, 'media', digest(expectedBytes)), Buffer.alloc(expectedBytes.length, 120));
    player = await createPlayer({ dataDir, config, port: 0, headless: true, connect: false });
    assert.equal(player.manifest, null); assert.match(player.status.lastError, /Cache/);
    await player.sync(); assert.equal(player.manifest.generation, 'generation-corrupt');
    assert.equal(await (await fetch(`${player.address}/media/asset/file`)).text(), expectedBytes.toString());
    await player.close(); player = null;
    // A fresh process can use the manifest and local media before any server request.
    player = await createPlayer({ dataDir, config, port: 0, headless: true, connect: false });
    assert.equal(player.manifest.generation, 'generation-corrupt');
    assert.equal(await (await fetch(`${player.address}/media/asset/file`)).text(), expectedBytes.toString());
    await player.close(); player = null;
    player = await createPlayer({ dataDir, config, port: 0, headless: true });
    await waitFor(() => streams.size > 0 && player.manifest?.generation === 'generation-corrupt');
    generation = 'generation-pushed';
    for (const stream of streams) stream.write('event: update\ndata: {}\n\n');
    await waitFor(() => player.manifest?.generation === 'generation-pushed');
    await new Promise(resolve => { remote.closeAllConnections(); remote.close(resolve); });
    await player.sync(); assert.equal(player.manifest.generation, 'generation-pushed');
  } finally {
    await player?.close(); for (const stream of streams) stream.destroy(); remote.closeAllConnections();
    await new Promise(resolve => remote.close(resolve));
    const approvedPrefix = path.join(here, '.test-cache-');
    if (!dataDir.startsWith(approvedPrefix)) throw new Error('Unexpected test directory.');
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('playback diagnostics are bounded and sanitized; playback errors survive sync until renderer recovery', async t => {
  const dataDir = await fs.mkdtemp(path.join(here, '.test-playback-diagnostic-'));
  let failManifest = false, heartbeat = null, player;
  const remote = http.createServer(async (req, res) => {
    if (req.url === '/api/player/manifest') {
      if (failManifest) { res.writeHead(503); res.end('{}'); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ schema: 1, generation: 'diagnostic-1', serverTime: new Date().toISOString(), programs: [], schedules: [], assets: [] }));
    } else if (req.url === '/api/player/heartbeat') {
      let body = ''; for await (const chunk of req) body += chunk;
      heartbeat = JSON.parse(body); res.end('{}');
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await player?.close(); remote.closeAllConnections(); await new Promise(resolve => remote.close(resolve));
    assert.ok(dataDir.startsWith(path.join(here, '.test-playback-diagnostic-')));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  player = await createPlayer({ dataDir, config: { id: 'diagnostic-player', token: 'private-credential-never-in-diagnostics', serverUrl: `http://127.0.0.1:${remote.address().port}` }, port: 0, headless: true, connect: false });
  const report = async body => {
    const response = await fetch(player.address + '/api/local/status', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-RJ-Request': '1' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); await response.json();
  };
  const status = async () => (await fetch(player.address + '/api/local/status')).json();
  const diagnosticFile = path.join(dataDir, 'logs', 'playback-diagnostic.json');
  const at = '2026-11-09T01:02:03.004Z';
  const healthyWidget = { widgetId: 'live-main', state: 'playing', reason: '', code: null, attempt: 1, at, width: 1280, height: 720 };
  await player.sync();
  await report({ status: 'playing', lastError: 'Siaran terputus.', playback: { renders: 1, youtube: [{ ...healthyWidget, state: 'fallback', reason: 'buffering', code: 153, url: 'https://private.invalid/stream', token: 'secret-diagnostic-extra' }], token: 'secret-diagnostic-extra' } });
  assert.equal(player.status.lastError, 'Siaran terputus.');
  await player.sync();
  assert.equal(player.status.lastError, 'Siaran terputus.', 'Successful CMS sync must not clear an active playback failure');
  assert.equal(heartbeat.lastError, 'Siaran terputus.');
  assert.equal(Object.hasOwn(heartbeat, 'playback'), false, 'Extra diagnostics stay local; heartbeat stays compatible');
  failManifest = true; await player.sync();
  const syncError = player.status.lastError;
  assert.match(syncError, /Server belum/);
  await report({ lastError: 'Siaran masih gagal.' });
  assert.equal(player.status.lastError, syncError, 'Renderer error must not hide the active sync failure');
  failManifest = false; await player.sync();
  assert.equal(player.status.lastError, 'Siaran masih gagal.', 'Recovering sync restores the outstanding playback error');
  failManifest = true; await player.sync();
  await report({ lastError: '', playback: { renders: 1, youtube: [healthyWidget] } });
  assert.match(player.status.lastError, /Server belum/, 'Renderer recovery must not clear an active sync failure');
  failManifest = false; await player.sync();
  assert.equal(player.status.lastError, '', 'Error clears after both playback and sync recover');
  assert.deepEqual((await status()).playback, { renders: 1, youtube: [healthyWidget] });
  const beforeRepeat = await fs.readFile(diagnosticFile, 'utf8');
  await report({ playback: { renders: 20, youtube: [{ ...healthyWidget, at: Date.now(), width: 1920 }] } });
  assert.equal(await fs.readFile(diagnosticFile, 'utf8'), beforeRepeat, 'Dimensions/time/renders alone must not repeatedly write history');
  await report({ playback: { renders: -1, youtube: [
    { widgetId: 'bad-url', state: 'https://private.invalid', reason: 'private-credential-never-in-diagnostics' },
    { widgetId: 'bad-dimensions', state: 'paused', reason: 'secret-diagnostic-extra', code: 999, attempt: -3, at: 'private-credential-never-in-diagnostics', width: 1e20, height: -1 },
    { widgetId: 123, state: 'playing' },
    { widgetId: 'https://private.invalid', state: 'playing' },
    ...Array.from({ length: 10 }, (_, index) => ({ ...healthyWidget, widgetId: 'extra-' + index })),
  ] } });
  const sanitized = (await status()).playback;
  assert.equal(sanitized.renders, 0);
  assert.ok(sanitized.youtube.length <= 8);
  assert.deepEqual(sanitized.youtube[0], { widgetId: 'bad-dimensions', state: 'paused', reason: '', code: null, attempt: 0, at: sanitized.youtube[0].at, width: 0, height: 0 });
  assert.match(sanitized.youtube[0].at, /^\d{4}-\d{2}-\d{2}T/);
  // Concurrent state changes exercise the serialized atomic-writer path.
  await Promise.all(Array.from({ length: 45 }, (_, index) => report({ playback: { renders: index, youtube: [{ ...healthyWidget, attempt: index + 2, state: index % 2 ? 'buffering' : 'playing' }] } })));
  const saved = JSON.parse(await fs.readFile(diagnosticFile, 'utf8'));
  assert.equal(saved.schema, 1); assert.equal(saved.history.length, 40);
  assert.deepEqual(saved.history.at(-1).youtube, (await status()).playback.youtube, 'Latest completed report cannot be overwritten by an older atomic write');
  const serialized = JSON.stringify(saved);
  assert.doesNotMatch(serialized, /private\.invalid|secret-diagnostic-extra|private-credential-never-in-diagnostics/);
  assert.equal(Object.hasOwn(saved, 'token'), false);
  assert.deepEqual((await fs.readdir(path.dirname(diagnosticFile))).sort(), ['playback-diagnostic.json'], 'Atomic writer leaves no temporary files');
});
