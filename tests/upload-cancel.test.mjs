import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSignageServer } from '../server/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/wlYAAAAASUVORK5CYII=', 'base64');
const videoChunk = Buffer.alloc(64 * 1024, 66);
videoChunk.write('ftypisom', 4, 'ascii');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error(message);
}

test('cancelled media uploads clean partial and pre-commit files while completed media remains valid', { timeout: 30000 }, async t => {
  const directory = path.join(root, 'tmp', 'upload-cancel-' + randomUUID());
  const mediaDirectory = path.join(directory, 'media');
  const backend = await createSignageServer({ dataDir: directory });
  backend.server.on('error', () => {});
  await new Promise((resolve, reject) => {
    backend.server.once('error', reject);
    backend.server.listen(0, '127.0.0.1', resolve);
  });
  const origin = 'http://127.0.0.1:' + backend.server.address().port;
  let cookie;
  const nativeRename = fs.rename;
  t.after(async () => {
    fs.rename = nativeRename;
    backend.server.closeAllConnections();
    await new Promise(resolve => backend.server.close(resolve));
    assert.ok(path.resolve(directory).startsWith(path.join(root, 'tmp', 'upload-cancel-')));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const setup = await fetch(origin + '/api/auth/setup', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-RJ-Request': '1' },
    body: JSON.stringify({ username: 'qa-upload-cancel', password: randomBytes(24).toString('hex') }),
  });
  assert.equal(setup.status, 201);
  cookie = setup.headers.get('set-cookie').split(';')[0];
  await setup.arrayBuffer();
  async function state() {
    const response = await fetch(origin + '/api/state', { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    return response.json();
  }
  function openUpload(name, length) {
    const request = http.request(origin + '/api/media', {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-RJ-Request': '1', 'X-Filename': name, 'Content-Type': 'video/mp4', 'Content-Length': length },
    });
    request.on('error', () => {}); // A deliberately destroyed socket reports ECONNRESET.
    request.on('response', response => response.resume());
    return request;
  }
  const baselineState = await state();
  const baselineFiles = (await fs.readdir(mediaDirectory)).sort();
  const baselineMedia = baselineState.media.map(m => ({ id: m.id, sha256: m.sha256, size: m.size }));
  async function assertUnchanged() {
    assert.deepEqual((await fs.readdir(mediaDirectory)).sort(), baselineFiles, 'Neither partial nor renamed orphan files remain');
    assert.deepEqual((await state()).media.map(m => ({ id: m.id, sha256: m.sha256, size: m.size })), baselineMedia);
    for (const m of baselineState.media) {
      assert.equal(createHash('sha256').update(await fs.readFile(path.join(mediaDirectory, m.id))).digest('hex'), m.sha256);
    }
  }

  await t.test('abort after partial body removes the temporary file and never registers media', async () => {
    const request = openUpload('cancel-in-progress.mp4', videoChunk.length * 4);
    request.write(videoChunk);
    await until(async () => (await fs.readdir(mediaDirectory)).some(name => name.endsWith('.part')), 'Server never received partial body');
    request.destroy();
    await until(async () => !(await fs.readdir(mediaDirectory)).some(name => name.endsWith('.part')), 'Cancelled partial file was not cleaned');
    await assertUnchanged();
  });

  await t.test('disconnect after body and file rename but before commit removes the renamed file', async () => {
    let markRenamed, releaseRename, renamedPath;
    const renamed = new Promise(resolve => { markRenamed = resolve; });
    const resume = new Promise(resolve => { releaseRename = resolve; });
    let markClosed;
    const closed = new Promise(resolve => { markClosed = resolve; });
    const onRequest = (request, response) => {
      if (request.headers['x-filename'] === 'cancel-before-commit.mp4') response.once('close', markClosed);
    };
    backend.server.on('request', onRequest);
    fs.rename = async (source, destination) => {
      await nativeRename(source, destination);
      if (path.dirname(source) === mediaDirectory && source.endsWith('.part')) {
        renamedPath = destination;
        markRenamed();
        await resume;
      }
    };
    const request = openUpload('cancel-before-commit.mp4', videoChunk.length);
    try {
      request.end(videoChunk);
      await Promise.race([renamed, delay(5000).then(() => { throw new Error('Upload did not reach pre-commit stage'); })]);
      assert.equal((await fs.stat(renamedPath)).size, videoChunk.length);
      request.destroy();
      await Promise.race([closed, delay(5000).then(() => { throw new Error('Server did not observe client disconnect'); })]);
      releaseRename();
      await until(async () => (await fs.readdir(mediaDirectory)).length === baselineFiles.length, 'Renamed cancelled upload was not cleaned');
      await assertUnchanged();
    } finally {
      releaseRename();
      fs.rename = nativeRename;
      backend.server.off('request', onRequest);
      request.destroy();
    }
  });

  await t.test('a new upload succeeds after cancellation and survives a late socket close', async () => {
    const response = await fetch(origin + '/api/media', {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-RJ-Request': '1', 'Content-Type': 'image/png', 'X-Filename': 'completed-after-cancel.png' }, body: png,
    });
    assert.equal(response.status, 201);
    const media = await response.json();
    assert.equal(media.size, png.length);
    assert.equal(media.sha256, createHash('sha256').update(png).digest('hex'));
    const current = await state();
    assert.equal(current.media.length, baselineMedia.length + 1);
    assert.equal(current.media.find(m => m.id === media.id).sha256, media.sha256);
    assert.deepEqual(await fs.readFile(path.join(mediaDirectory, media.id)), png);
    assert.ok(!(await fs.readdir(mediaDirectory)).some(name => name.endsWith('.part')));
    const file = await fetch(origin + media.url, { headers: { Cookie: cookie, Range: 'bytes=0-7' } });
    assert.equal(file.status, 206);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), png.subarray(0, 8));
  });
});
