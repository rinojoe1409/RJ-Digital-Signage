import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSignageServer } from '../server/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.RJ_PLAYER_EXE;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = value => createHash('sha256').update(value).digest('hex');
async function waitFor(check, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await pause(100); }
  throw new Error(message);
}
async function run(file, args, input = '') {
  const child = spawn(file, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errors += data; });
  child.stdin.end(input);
  const timeout = setTimeout(() => child.kill(), 30000);
  try { const [code] = await once(child, 'exit'); return { code, output, errors }; }
  finally { clearTimeout(timeout); }
}
async function folderSnapshot(directory) {
  try {
    const stat = await fs.stat(directory);
    return { exists: true, directory: stat.isDirectory(), entries: stat.isDirectory() ? (await fs.readdir(directory)).sort() : [] };
  } catch (error) { if (error.code === 'ENOENT') return { exists: false }; throw error; }
}
async function localStatus() {
  try { return await (await fetch('http://127.0.0.1:3211/api/local/status', { signal: AbortSignal.timeout(1000) })).json(); }
  catch { return null; }
}

test('Packaged EXE resolves an accessible content default and migrates only media while pairing stays private', {
  skip: process.platform !== 'win32' || !executable,
  timeout: 120000,
}, async () => {
  // No real player is stopped or replaced by this test. All starts use a unique private data directory.
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(3211, '127.0.0.1', resolve); });
  await new Promise(resolve => probe.close(resolve));
  const folder = path.join(root, 'tmp', 'content-folder-exe-' + randomUUID());
  const dataDir = path.join(folder, 'private data');
  const contentDir = path.join(folder, 'Content RJ Digital');
  const defaultContent = path.join(os.homedir(), 'Content RJ Digital');
  const defaultPrivate = path.join(process.env.LOCALAPPDATA, 'RJ Digital Signage Player', 'data');
  const profileContentBefore = await folderSnapshot(defaultContent);
  const profilePrivateBefore = await folderSnapshot(defaultPrivate);
  await fs.mkdir(folder, { recursive: true });
  const payload = path.dirname(executable);
  let backend, desktop;
  const launchArgs = mediaDir => ['--headless', '--data-dir', dataDir, ...(mediaDir ? ['--media-dir', mediaDir] : [])];
  async function stopDesktop(mediaDir) {
    if (!desktop) return;
    const stopped = await run(executable, ['--shutdown', '--data-dir', dataDir, ...(mediaDir ? ['--media-dir', mediaDir] : [])]);
    assert.equal(stopped.code, 0, 'Shutdown IPC succeeds for the isolated player');
    await waitFor(async () => desktop.exitCode !== null && !(await localStatus()), 'Isolated desktop/agent did not stop');
    desktop = null;
  }
  function startDesktop(mediaDir) {
    desktop = spawn(executable, launchArgs(mediaDir), { windowsHide: true, stdio: 'ignore' });
    desktop.once('error', () => {});
  }
  try {
    async function diagnose(args, name) {
      const destination = path.join(folder, name + '.json');
      const checked = await run(executable, ['--self-test', '--diagnostic-result', destination, ...args]);
      assert.equal(checked.code, 0, checked.errors || 'Packaged diagnostic succeeds');
      const result = JSON.parse(await fs.readFile(destination, 'utf8'));
      assert.equal(result.ok, true);
      return result;
    }
    const defaults = await diagnose([], 'default-paths');
    assert.equal(path.resolve(defaults.contentDirectory), defaultContent);
    assert.equal(path.resolve(defaults.dataDirectory), defaultPrivate);
    assert.deepEqual(await folderSnapshot(defaultContent), profileContentBefore, 'Diagnostic must not create or populate a real profile content folder');
    assert.deepEqual(await folderSnapshot(defaultPrivate), profilePrivateBefore, 'Diagnostic must not create or populate real private player data');
    const customData = await diagnose(['--data-dir', dataDir], 'custom-data');
    assert.equal(path.resolve(customData.contentDirectory), path.join(dataDir, 'media'), 'Custom data-dir keeps its isolated legacy media default');
    const explicitBefore = await diagnose(['--media-dir', contentDir, '--data-dir', dataDir], 'explicit-before');
    const explicitAfter = await diagnose(['--data-dir', dataDir, '--media-dir', contentDir], 'explicit-after');
    assert.equal(path.resolve(explicitBefore.contentDirectory), contentDir);
    assert.equal(path.resolve(explicitAfter.contentDirectory), contentDir, 'Argument order must not change an explicit content directory');
    assert.equal((await folderSnapshot(contentDir)).exists, false, 'Resolving a diagnostic path must not create it');

    backend = await createSignageServer({ dataDir: path.join(folder, 'cms') });
    await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
    const serverUrl = 'http://127.0.0.1:' + backend.server.address().port;
    let cookie = '';
    async function admin(route, method = 'GET', body, headers = {}) {
      const binary = Buffer.isBuffer(body);
      const response = await fetch(serverUrl + route, { method, headers: {
        'X-RJ-Request': '1', ...(cookie ? { Cookie: cookie } : {}),
        ...(body !== undefined && !binary ? { 'Content-Type': 'application/json' } : {}), ...headers,
      }, body: body === undefined ? undefined : binary ? body : JSON.stringify(body) });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      const value = await response.json(); assert.ok(response.ok, route + ': ' + (value.error || response.status)); return value;
    }
    await admin('/api/auth/setup', 'POST', { username: 'qa-content-folder', password: randomBytes(24).toString('hex') });
    // An MP4-signature fixture verifies transport bytes, not codec decoding or video smoothness.
    const video = Buffer.alloc(128 * 1024, 71); video.write('ftypisom', 4, 'ascii');
    const media = await admin('/api/media', 'POST', video, { 'Content-Type': 'video/mp4', 'X-Filename': 'content-migration.mp4' });
    assert.equal(media.sha256, sha256(video));
    const { code } = await admin('/api/players/pair-code', 'POST', {});
    const paired = await run(path.join(payload, 'runtime', 'node.exe'), [path.join(payload, 'player', 'agent.mjs'), 'pair', '--json', '--data-dir', dataDir],
      JSON.stringify({ serverUrl, code, name: 'Isolated content folder player' }));
    assert.equal(paired.code, 0, paired.errors);
    assert.equal(JSON.parse(paired.output).ok, true);
    assert.equal(paired.output.includes('"token"'), false);
    const configPath = path.join(dataDir, 'config.json');
    const configBytes = await fs.readFile(configPath);
    const config = JSON.parse(configBytes);
    const draft = await admin('/api/layouts', 'POST', { name: 'Content migration fixture', width: 1280, height: 720,
      widgets: [{ id: 'media', type: 'video', x: 0, y: 0, width: 1280, height: 720, mediaId: media.id, muted: true }] });
    const publication = (await admin('/api/layouts/' + draft.id + '/publish', 'POST', { playerIds: [config.id] })).publication;

    // Seed a cache using the packaged EXE's custom-data fallback, as an older installation would.
    startDesktop();
    await waitFor(async () => {
      const status = await localStatus();
      return status?.playerId === config.id && status.progress === 100 && path.resolve(status.contentDirectory) === path.join(dataDir, 'media');
    }, 'Packaged EXE did not download to the custom private legacy cache');
    const oldFile = path.join(dataDir, 'media', media.sha256);
    await waitFor(async () => fs.stat(oldFile).then(stat => stat.size === video.length).catch(() => false), 'Legacy cache was not populated');
    await stopDesktop();
    assert.equal(sha256(await fs.readFile(oldFile)), media.sha256);

    startDesktop(contentDir);
    await waitFor(async () => {
      const status = await localStatus();
      return status?.playerId === config.id && status.progress === 100 && path.resolve(status.contentDirectory) === contentDir;
    }, 'Packaged EXE did not use the selected content directory');
    const contentFile = path.join(contentDir, media.sha256);
    assert.equal(sha256(await fs.readFile(contentFile)), media.sha256, 'The migrated bytes match the original media');
    assert.equal(sha256(await fs.readFile(oldFile)), media.sha256, 'The prior cache remains intact');
    assert.equal(sha256(await fs.readFile(configPath)), sha256(configBytes), 'Changing content storage preserves pairing credentials byte-for-byte');
    const forbidden = ['config.json', 'manifest.json', 'media-index.json', 'logs', '.agent-running'];
    for (const name of forbidden) assert.equal((await folderSnapshot(path.join(contentDir, name))).exists, false, 'Private player data is not copied into content storage: ' + name);
    const served = await fetch('http://127.0.0.1:3211/media/' + media.id + '/file');
    assert.equal(served.headers.get('content-type'), 'video/mp4');
    assert.equal(sha256(Buffer.from(await served.arrayBuffer())), media.sha256);
    const range = await fetch('http://127.0.0.1:3211/media/' + media.id + '/file', { headers: { Range: 'bytes=0-31' } });
    assert.equal(range.status, 206);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), video.subarray(0, 32));
    const before = await (await fetch('http://127.0.0.1:3211/api/local/manifest')).json();
    assert.equal(before.defaultPublicationId, publication.id);
    await stopDesktop(contentDir);
    backend.server.closeAllConnections(); await new Promise(resolve => backend.server.close(resolve)); backend = null;
    startDesktop(contentDir);
    await waitFor(async () => (await localStatus())?.playerId === config.id, 'Offline packaged EXE did not start from migrated content');
    const offline = await (await fetch('http://127.0.0.1:3211/api/local/manifest')).json();
    assert.equal(offline.generation, before.generation);
    assert.equal(offline.defaultPublicationId, publication.id);
    assert.equal(sha256(Buffer.from(await (await fetch('http://127.0.0.1:3211/media/' + media.id + '/file')).arrayBuffer())), media.sha256);
    assert.equal(sha256(await fs.readFile(configPath)), sha256(configBytes));
    await stopDesktop(contentDir);
    assert.deepEqual(await folderSnapshot(defaultContent), profileContentBefore);
    assert.deepEqual(await folderSnapshot(defaultPrivate), profilePrivateBefore);
    await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
    await fs.writeFile(path.join(root, 'artifacts', 'content-folder-desktop-result.json'), JSON.stringify({
      packagedExe: true, defaultContentFolderResolved: true, diagnosticDoesNotCreateProfileFolders: true,
      customDataDirectoryIsolated: true, explicitMediaDirectoryOrderIndependent: true,
      packagedLegacyCacheSeeded: true, migratedMediaServedWithCorrectMimeAndRange: true,
      sourceCachePreserved: true, privatePairingUnchanged: true, privateFilesNotExposedInContent: true,
      offlineColdStartSucceeded: true, visibleKioskOpened: false,
    }, null, 2) + '\n');
  } finally {
    if (desktop) {
      await run(executable, ['--shutdown', '--data-dir', dataDir, '--media-dir', contentDir]).catch(() => {});
      if (desktop.exitCode === null) desktop.kill();
    }
    if (backend) { backend.server.closeAllConnections(); await new Promise(resolve => backend.server.close(resolve)); }
    assert.ok(path.resolve(folder).startsWith(path.join(root, 'tmp') + path.sep));
    await fs.rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
