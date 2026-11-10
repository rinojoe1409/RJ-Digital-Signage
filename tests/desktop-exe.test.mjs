import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSignageServer } from '../server/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.RJ_PLAYER_EXE;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, message, timeout = 20000) {
  const limit = Date.now() + timeout;
  while (Date.now() < limit) { if (await check()) return; await delay(100); }
  throw new Error(message);
}
async function run(file, args, input) {
  const child = spawn(file, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errors += data; });
  child.stdin.end(input || '');
  const timer = setTimeout(() => child.kill(), 45000);
  try { const [code] = await once(child, 'exit'); return { code, output, errors }; }
  finally { clearTimeout(timer); }
}
async function local(route) {
  try { return await (await fetch('http://127.0.0.1:3211' + route, { signal: AbortSignal.timeout(1500) })).json(); }
  catch { return null; }
}

test('EXE terkemas: diagnostik, pairing privat, supervisi proses, shutdown dan cold start offline', {
  skip: process.platform !== 'win32' || !executable,
  timeout: 120000,
}, async () => {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(3211, '127.0.0.1', resolve); });
  await new Promise(resolve => probe.close(resolve));
  const folder = path.join(root, 'tmp', 'exe-qa-' + randomUUID());
  const dataDir = path.join(folder, 'data with spaces');
  await fs.mkdir(folder, { recursive: true });
  const payload = path.dirname(executable);
  let backend, desktop;
  try {
    const diagnostic = path.join(folder, 'diagnostic.json');
    const checked = await run(executable, ['--self-test', '--diagnostic-result', diagnostic]);
    assert.equal(checked.code, 0, 'Diagnostik EXE terkemas lulus');
    const result = JSON.parse(await fs.readFile(diagnostic, 'utf8'));
    assert.equal(result.ok, true);
    assert.match(result.runtimeVersion, /^24\./);

    backend = await createSignageServer({ dataDir: path.join(folder, 'server') });
    await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
    const serverUrl = 'http://127.0.0.1:' + backend.server.address().port;
    let cookie = '';
    async function admin(route, method = 'GET', body) {
      const response = await fetch(serverUrl + route, { method,
        headers: { 'X-RJ-Request': '1', ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      const value = await response.json();
      assert.ok(response.ok, route + ': ' + (value.error || response.status));
      return value;
    }
    await admin('/api/auth/setup', 'POST', { username: 'qa-exe', password: randomBytes(24).toString('hex') });
    const code = await admin('/api/players/pair-code', 'POST', {});
    const paired = await run(path.join(payload, 'runtime', 'node.exe'), [path.join(payload, 'player', 'agent.mjs'), 'pair', '--json', '--data-dir', dataDir],
      JSON.stringify({ serverUrl, code: code.code, name: 'QA EXE player' }));
    assert.equal(paired.code, 0, paired.errors);
    assert.equal(JSON.parse(paired.output).ok, true);
    assert.equal(paired.output.includes('"token"'), false);
    const config = JSON.parse(await fs.readFile(path.join(dataDir, 'config.json'), 'utf8'));
    const state = await admin('/api/state');
    const published = await admin('/api/layouts/' + state.layouts[0].id + '/publish', 'POST', { playerIds: [config.id] });
    const startDesktop = () => {
      const child = spawn(executable, ['--headless', '--data-dir', dataDir], { windowsHide: true, stdio: 'ignore' });
      child.once('error', () => {});
      return child;
    };
    desktop = startDesktop();
    await waitFor(async () => (await local('/api/local/status'))?.playerId === config.id, 'Native EXE tidak membuka agen terkemas');
    await waitFor(async () => (await local('/api/local/manifest'))?.defaultPublicationId === published.publication.id, 'EXE belum menerima publish');
    const firstOwner = JSON.parse(await fs.readFile(path.join(dataDir, '.agent-running', 'owner.json'), 'utf8'));
    process.kill(firstOwner.pid);
    await waitFor(async () => {
      try {
        const owner = JSON.parse(await fs.readFile(path.join(dataDir, '.agent-running', 'owner.json'), 'utf8'));
        return owner.pid !== firstOwner.pid && (await local('/api/local/status'))?.playerId === config.id;
      } catch { return false; }
    }, 'Supervisor EXE belum memulihkan agen yang berhenti', 30000);
    const before = await local('/api/local/manifest');
    const stopped = await run(executable, ['--shutdown', '--data-dir', dataDir]);
    assert.equal(stopped.code, 0, 'Shutdown IPC berhasil');
    await waitFor(async () => !(await local('/api/local/status')), 'Agen masih berjalan setelah launcher berhenti');
    await waitFor(async () => desktop.exitCode !== null, 'Launcher belum berhenti');
    desktop = null;
    backend.server.closeAllConnections();
    await new Promise(resolve => backend.server.close(resolve));
    backend = null;
    desktop = startDesktop();
    await waitFor(async () => (await local('/api/local/status'))?.playerId === config.id, 'Cold start EXE offline belum siap');
    const offline = await local('/api/local/manifest');
    assert.equal(offline.generation, before.generation);
    assert.equal(offline.defaultPublicationId, published.publication.id);
    const log = await fs.readFile(path.join(dataDir, 'logs', 'player-desktop.log'), 'utf8');
    assert.equal(log.includes(config.token), false, 'Log tidak mengandung bearer token');
  } finally {
    if (desktop) {
      await run(executable, ['--shutdown', '--data-dir', dataDir]).catch(() => {});
      if (desktop.exitCode === null) desktop.kill();
    }
    if (backend) { backend.server.closeAllConnections(); await new Promise(resolve => backend.server.close(resolve)); }
    assert.ok(path.resolve(folder).startsWith(path.join(root, 'tmp') + path.sep));
    await fs.rm(folder, { recursive: true, force: true });
  }
});
