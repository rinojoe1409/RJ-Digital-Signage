import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { prepareContentDirectory } from './content-cache.mjs';
import { createPlayer } from './agent.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const video = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
async function fixture(t) {
  const directory = path.join(root, 'tmp', 'content-cache-' + randomUUID());
  await fs.mkdir(directory, { recursive: true });
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.join(root, 'tmp', 'content-cache-')));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return directory;
}

test('content migration copies only verified cache, retains old originals and is safe to repeat', async t => {
  const directory = await fixture(t), legacy = path.join(directory, 'data', 'media'), content = path.join(directory, 'Content RJ Digital');
  await fs.mkdir(legacy, { recursive: true }); await fs.mkdir(content);
  const hash = digest(video), corruptHash = 'a'.repeat(64);
  await fs.writeFile(path.join(legacy, hash), video);
  await fs.writeFile(path.join(legacy, corruptHash), 'not the named hash');
  await fs.writeFile(path.join(legacy, hash + '.part'), 'incomplete');
  await fs.writeFile(path.join(legacy, 'config.json'), 'not content');
  await fs.mkdir(path.join(legacy, 'b'.repeat(64)));
  await fs.writeFile(path.join(content, 'catatan.txt'), 'keep this user file');
  const result = await prepareContentDirectory(legacy, content);
  assert.deepEqual(result, { copied: 1, reused: 0, skipped: 4 });
  assert.deepEqual(await fs.readFile(path.join(content, hash)), video);
  assert.deepEqual(await fs.readFile(path.join(legacy, hash)), video);
  assert.deepEqual((await fs.readdir(content)).sort(), ['catatan.txt', hash].sort());
  assert.equal(await fs.readFile(path.join(content, 'catatan.txt'), 'utf8'), 'keep this user file');
  assert.deepEqual(await prepareContentDirectory(legacy, content), { copied: 0, reused: 1, skipped: 4 });
  // The old cache is a real independent backup, not a link to editable content.
  await fs.writeFile(path.join(content, hash), 'changed outside the player');
  assert.deepEqual(await fs.readFile(path.join(legacy, hash)), video);
});

test('a conflicting destination is never replaced and an unusable folder leaves the source intact', async t => {
  const directory = await fixture(t), legacy = path.join(directory, 'old-media'), content = path.join(directory, 'Content RJ Digital');
  await fs.mkdir(legacy); await fs.mkdir(content);
  const hash = digest(video), foreign = Buffer.from('existing different user file');
  await fs.writeFile(path.join(legacy, hash), video); await fs.writeFile(path.join(content, hash), foreign);
  await assert.rejects(prepareContentDirectory(legacy, content), /berkas yang berbeda/i);
  assert.deepEqual(await fs.readFile(path.join(content, hash)), foreign);
  assert.deepEqual(await fs.readFile(path.join(legacy, hash)), video);
  assert.equal((await fs.readdir(content)).some(name => name.endsWith('.part')), false);
  const blocked = path.join(directory, 'blocked'); await fs.writeFile(blocked, 'a file, not a folder');
  await assert.rejects(prepareContentDirectory(legacy, path.join(blocked, 'Content RJ Digital')), /Folder konten belum dapat digunakan/);
  assert.deepEqual(await fs.readFile(path.join(legacy, hash)), video);
  assert.equal(await fs.readFile(blocked, 'utf8'), 'a file, not a folder');
});

test('external content keeps pairing private, downloads exact bytes, serves ranges and restarts offline', async t => {
  const directory = await fixture(t), dataDir = path.join(directory, 'private-data'), legacy = path.join(dataDir, 'media');
  const mediaDir = path.join(directory, 'Content RJ Digital'), firstHash = digest(video), nextVideo = Buffer.concat([video, Buffer.from('second video bytes')]);
  const first = { id: 'old-video', name: 'old.mp4', mime: 'video/mp4', kind: 'video', size: video.length, sha256: firstHash };
  const next = { id: 'next-video', name: 'next.mp4', mime: 'video/mp4', kind: 'video', size: nextVideo.length, sha256: digest(nextVideo) };
  let manifest = { schema: 1, generation: 'old-generation', playerId: 'content-player', serverTime: new Date().toISOString(), settings: {}, schedules: [],
    defaultPublicationId: 'content-publication', programs: [{ id: 'content-publication', layout: { id: 'content-layout', widgets: [] } }], assets: [first] };
  const reports = [], downloads = [];
  const remote = http.createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer test-content-private-token');
    if (request.url === '/api/player/manifest') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(manifest)); }
    else if (request.url === '/api/player/media/next-video/file') { downloads.push(next.id); response.end(nextVideo); }
    else if (request.url === '/api/player/heartbeat') { let body = ''; for await (const chunk of request) body += chunk; reports.push(JSON.parse(body)); response.end('{}'); }
    else { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  let player, remoteOpen = true;
  t.after(async () => {
    await player?.close();
    if (remoteOpen) { remote.closeAllConnections(); await new Promise(resolve => remote.close(resolve)); }
  });
  await fs.mkdir(legacy, { recursive: true }); await fs.writeFile(path.join(legacy, firstHash), video);
  const config = { id: 'content-player', token: 'test-content-private-token', serverUrl: 'http://127.0.0.1:' + remote.address().port };
  const configText = JSON.stringify(config);
  await fs.writeFile(path.join(dataDir, 'config.json'), configText);
  await fs.writeFile(path.join(dataDir, 'manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(dataDir, 'media-index.json'), JSON.stringify({ [first.id]: first }));
  const options = { dataDir, mediaDir, port: 0, headless: true, connect: false };
  player = await createPlayer(options);
  assert.equal(player.manifest.generation, 'old-generation');
  assert.equal(player.mediaDir, mediaDir);
  const status = await (await fetch(player.address + '/api/local/status')).json();
  assert.equal(status.contentDirectory, mediaDir);
  assert.equal(JSON.stringify(status).includes(config.token), false);
  const range = await fetch(player.address + '/media/old-video/file', { headers: { Range: 'bytes=4-7' } });
  assert.equal(range.status, 206); assert.equal(range.headers.get('content-type'), 'video/mp4');
  assert.equal(Buffer.from(await range.arrayBuffer()).toString(), 'ftyp');
  assert.deepEqual(await fs.readFile(path.join(legacy, firstHash)), video);
  manifest = { ...manifest, generation: 'next-generation', assets: [first, next] };
  await player.sync();
  assert.deepEqual(downloads, ['next-video']);
  assert.deepEqual(await fs.readFile(path.join(mediaDir, next.sha256)), nextVideo);
  assert.equal(await fs.stat(path.join(legacy, next.sha256)).catch(() => null), null);
  assert.equal(await fs.readFile(path.join(dataDir, 'config.json'), 'utf8'), configText);
  for (const report of reports) {
    assert.equal(Object.hasOwn(report, 'contentDirectory'), false);
    assert.equal(JSON.stringify(report).includes(mediaDir), false);
  }
  assert.deepEqual((await fs.readdir(mediaDir)).sort(), [firstHash, next.sha256].sort());
  await player.close(); player = null;
  remote.closeAllConnections(); await new Promise(resolve => remote.close(resolve)); remoteOpen = false;
  // Simulate later removal of the old copy: the new content folder is sufficient.
  await fs.rm(path.join(legacy, firstHash));
  player = await createPlayer(options);
  assert.equal(player.manifest.generation, 'next-generation');
  assert.deepEqual(Buffer.from(await (await fetch(player.address + '/media/next-video/file')).arrayBuffer()), nextVideo);
  await player.close(); player = null;
});

test('an isolated data directory retains its own media folder unless explicitly overridden', async t => {
  const directory = await fixture(t), dataDir = path.join(directory, 'isolated-data');
  const player = await createPlayer({ dataDir, config: { id: 'isolated-player', token: 'isolated-test-token', serverUrl: 'http://127.0.0.1:1/' }, port: 0, headless: true, connect: false });
  t.after(() => player.close());
  assert.equal(player.mediaDir, path.join(dataDir, 'media'));
  assert.ok((await fs.stat(player.mediaDir)).isDirectory());
});
