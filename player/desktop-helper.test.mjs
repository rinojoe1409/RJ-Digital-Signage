import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createPlayer, pairPlayer } from './agent.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = { id: 'isolated-player', token: randomBytes(32).toString('hex'), serverUrl: 'http://127.0.0.1:1/' };

function child(args) {
  const processHandle = spawn(process.execPath, [path.join(here, 'agent.mjs'), ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  processHandle.stdout.on('data', bytes => { stdout += bytes; });
  processHandle.stderr.on('data', bytes => { stderr += bytes; });
  const exited = new Promise((resolve, reject) => {
    processHandle.once('error', reject);
    processHandle.once('close', code => resolve({ code, stdout, stderr }));
  });
  return { processHandle, exited, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Player helper did not reach the expected state.');
}

test('desktop pairing keeps secrets private, refuses implicit replace and resets only metadata after successful replace', { timeout: 60000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(here, '.test-desktop-pair-'));
  const issuedToken = randomBytes(32).toString('hex');
  let requests = 0, deny = false, identity = 'desktop-paired';
  const remote = http.createServer(async (request, response) => {
    requests++;
    assert.equal(request.url, '/api/player/pair');
    let body = '';
    for await (const chunk of request) body += chunk;
    assert.deepEqual(JSON.parse(body), { code: '123456', name: 'PC Player Uji' });
    response.setHeader('Content-Type', 'application/json');
    response.statusCode = deny ? 401 : 201;
    response.end(JSON.stringify(deny ? { error: issuedToken } : { id: identity, token: issuedToken }));
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  const serverUrl = `http://127.0.0.1:${remote.address().port}/`;
  const input = { serverUrl, code: '123456', name: 'PC Player Uji' };
  const processes = [];
  try {
    const first = child(['pair', '--json', '--data-dir', dataDir]); processes.push(first);
    first.processHandle.stdin.end(JSON.stringify(input));
    const output = await first.exited;
    assert.equal(output.code, 0, output.stderr);
    assert.deepEqual(JSON.parse(output.stdout), { ok: true, playerId: identity, name: input.name, serverUrl });
    assert.ok(!output.stdout.includes(issuedToken) && !output.stderr.includes(issuedToken));
    const previous = JSON.parse(await fs.readFile(path.join(dataDir, 'config.json'), 'utf8'));
    assert.equal(previous.token, issuedToken);
    await fs.writeFile(path.join(dataDir, 'manifest.json'), JSON.stringify({ generation: 'previous' }));
    await fs.writeFile(path.join(dataDir, 'media-index.json'), '{}');
    await fs.mkdir(path.join(dataDir, 'media'));
    await fs.writeFile(path.join(dataDir, 'media', 'keep-cache-blob'), 'retained content');
    const count = requests;
    await assert.rejects(pairPlayer(input, { dataDir }), /sudah dipasangkan/);
    assert.equal(requests, count);
    deny = true;
    const denied = child(['pair', '--json', '--replace', '--data-dir', dataDir]); processes.push(denied);
    denied.processHandle.stdin.end(JSON.stringify(input));
    const failure = await denied.exited;
    assert.equal(failure.code, 1);
    assert.equal(JSON.parse(failure.stderr).error, 'Kode pemasangan salah atau kedaluwarsa.');
    assert.ok(!failure.stderr.includes(issuedToken));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'config.json'), 'utf8')), previous);
    assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'manifest.json'), 'utf8')).generation, 'previous');
    deny = false; identity = 'desktop-replaced';
    await pairPlayer(input, { dataDir, replace: true });
    assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'config.json'), 'utf8')).id, identity);
    await assert.rejects(fs.access(path.join(dataDir, 'manifest.json')), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(dataDir, 'media-index.json')), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(dataDir, 'pairing-reset.json')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(dataDir, 'media', 'keep-cache-blob'), 'utf8'), 'retained content');
  } finally {
    for (const process of processes) if (process.processHandle.exitCode === null) process.processHandle.kill();
    remote.closeAllConnections(); await new Promise(resolve => remote.close(resolve));
    assert.ok(dataDir.startsWith(path.join(here, '.test-desktop-pair-')));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('one agent owns each data directory; release is idempotent and stale crashed ownership can recover', async () => {
  const dataDir = await fs.mkdtemp(path.join(here, '.test-desktop-lock-'));
  let player;
  try {
    player = await createPlayer({ dataDir, config, port: 0, headless: true, connect: false });
    await assert.rejects(createPlayer({ dataDir, config, port: 0, headless: true, connect: false }), /sedang berjalan/);
    const status = await (await fetch(`${player.address}/api/local/status`)).json();
    assert.equal(status.application, 'RJDigitalSignagePlayer');
    assert.ok(!JSON.stringify(status).includes(config.token));
    await Promise.all([player.close(), player.close()]); player = null;
    const stopped = spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { stopped.once('error', reject); stopped.once('exit', resolve); });
    await fs.mkdir(path.join(dataDir, '.agent-running'));
    await fs.writeFile(path.join(dataDir, '.agent-running', 'owner.json'), JSON.stringify({ pid: stopped.pid, instance: 'crashed' }));
    player = await createPlayer({ dataDir, config, port: 0, headless: true, connect: false });
    assert.ok(player.address.startsWith('http://127.0.0.1:'));
  } finally {
    await player?.close();
    assert.ok(dataDir.startsWith(path.join(here, '.test-desktop-lock-')));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('supervisor start handshake, shutdown and EOF manage only the headless child agent', { timeout: 30000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(here, '.test-desktop-supervisor-'));
  const processes = [];
  try {
    await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify(config));
    for (const endWithEof of [false, true]) {
      const running = child(['--supervised', '--headless', '--port', '0', '--data-dir', dataDir]); processes.push(running);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(running.stdout, '', 'No service or Edge starts before the launcher assigns its job and sends start');
      await assert.rejects(fs.access(path.join(dataDir, '.agent-running')), { code: 'ENOENT' });
      running.processHandle.stdin.write(JSON.stringify({ command: 'start' }) + '\n');
      await waitFor(() => running.stdout.includes('"event":"ready"'));
      const ready = JSON.parse(running.stdout.trim());
      const response = await fetch(`${ready.address}/api/local/status`);
      assert.equal(response.status, 200);
      if (endWithEof) running.processHandle.stdin.end();
      else running.processHandle.stdin.write(JSON.stringify({ command: 'shutdown' }) + '\n');
      assert.equal((await running.exited).code, 0, running.stderr);
      await assert.rejects(fetch(`${ready.address}/api/local/status`));
      await assert.rejects(fs.access(path.join(dataDir, '.agent-running')), { code: 'ENOENT' });
    }
    const beforeStart = child(['--supervised', '--headless', '--port', '0', '--data-dir', dataDir]); processes.push(beforeStart);
    beforeStart.processHandle.stdin.end();
    assert.equal((await beforeStart.exited).code, 0);
    assert.equal(beforeStart.stdout, '');
  } finally {
    for (const process of processes) if (process.processHandle.exitCode === null) process.processHandle.kill();
    assert.ok(dataDir.startsWith(path.join(here, '.test-desktop-supervisor-')));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
