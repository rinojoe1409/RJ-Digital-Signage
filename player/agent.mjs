import http from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { prepareContentDirectory } from './content-cache.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.dirname(here);
const windowsPowerShell = path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const windowsPowerShellEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH'));
const safeId = value => /^[a-zA-Z0-9_-]{1,120}$/.test(value || '');
const sleep = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
const json = (response, code, value) => { response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
const youtubeStates = new Set(['static', 'connecting', 'playing', 'buffering', 'paused', 'fallback']);
const youtubeReasons = new Set(['', 'url', 'size', 'obscured', 'offline', 'startup', 'buffering', 'error', 'autoplay', 'api', 'ended']);
const youtubeCodes = new Set([2, 5, 100, 101, 150, 153]);
const diagnosticCount = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000000 ? value : 0;
const diagnosticSize = value => Number.isFinite(value) && value >= 0 && value <= 65536 ? Math.round(value * 100) / 100 : 0;
function diagnosticTime(value) {
  if ((typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8640000000000000)) {
    const date = new Date(value);
    if (Number.isFinite(+date)) return date.toISOString();
  }
  return new Date().toISOString();
}
function sanitizePlayback(value) {
  const youtube = [], seen = new Set();
  if (value && typeof value === 'object' && Array.isArray(value.youtube)) {
    for (const widget of value.youtube.slice(0, 8)) {
      if (!widget || typeof widget !== 'object' || typeof widget.widgetId !== 'string' || !safeId(widget.widgetId) || seen.has(widget.widgetId) || !youtubeStates.has(widget.state)) continue;
      seen.add(widget.widgetId);
      youtube.push({ widgetId: widget.widgetId, state: widget.state, reason: youtubeReasons.has(widget.reason) ? widget.reason : '',
        code: youtubeCodes.has(widget.code) ? widget.code : null, attempt: diagnosticCount(widget.attempt), at: diagnosticTime(widget.at),
        width: diagnosticSize(widget.width), height: diagnosticSize(widget.height) });
    }
  }
  return { renders: diagnosticCount(value?.renders), youtube };
}
const playbackSignature = value => JSON.stringify(value.youtube.map(({ widgetId, state, reason, code, attempt }) => ({ widgetId, state, reason, code, attempt })));

async function readJson(filename, fallback = null) {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return fallback; throw error; }
}
async function atomicJson(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  try { await fs.rename(temporary, filename); }
  catch (error) { await fs.rm(temporary, { force: true }); throw error; }
}

function serverBase(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Alamat server harus HTTP/HTTPS tanpa kredensial.');
  url.pathname = '/'; url.search = ''; url.hash = ''; return url.href;
}

async function playerLock(dataDir) {
  const folder = path.join(dataDir, '.agent-running');
  const ownerFile = path.join(folder, 'owner.json');
  const instance = randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fs.mkdir(folder);
      try { await fs.writeFile(ownerFile, JSON.stringify({ pid: process.pid, instance }), { flag: 'wx', mode: 0o600 }); }
      catch (error) { await fs.rmdir(folder).catch(() => {}); throw error; }
      return async () => {
        const owner = await readJson(ownerFile);
        if (owner?.instance === instance) {
          await fs.rm(ownerFile, { force: true });
          await fs.rmdir(folder).catch(() => {});
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = await fs.lstat(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Folder pengunci player tidak valid.');
      const owner = await readJson(ownerFile);
      if (Number.isInteger(owner?.pid) && owner.pid > 0) {
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (error) { alive = error.code !== 'ESRCH'; }
        if (alive) throw new Error('RJ Player sedang berjalan atau sedang dipasangkan. Tutup proses sebelumnya terlebih dahulu.');
        await fs.rm(ownerFile, { force: true });
      } else if (Date.now() - stat.mtimeMs < 10000) {
        throw new Error('RJ Player sedang mulai. Tunggu beberapa detik lalu coba lagi.');
      } else await fs.rm(ownerFile, { force: true });
      // Remove only an empty owned lock directory; never recursively delete arbitrary contents.
      await fs.rmdir(folder);
    }
  }
  throw new Error('Pengunci player belum dapat diambil.');
}

async function protectData(dataDir, configPath) {
  if (process.platform !== 'win32') return;
  await new Promise((resolve, reject) => {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'Protect-Config.ps1'), '-DataDir', dataDir];
    if (configPath) args.push('-ConfigPath', configPath);
    const child = spawn(windowsPowerShell, args, { windowsHide: true, stdio: 'ignore', env: windowsPowerShellEnvironment() });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Perlindungan penyimpanan player melewati batas waktu.')); }, 15000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('Perlindungan penyimpanan player belum dapat dijalankan.')); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Penyimpanan player belum berhasil diamankan. Pemasangan dibatalkan.')); });
  });
}

/** Pairing helper for the desktop launcher. The returned object never contains the bearer token. */
export async function pairPlayer(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Data pemasangan tidak valid.');
  if (typeof input.serverUrl !== 'string' || typeof input.code !== 'string' || typeof input.name !== 'string') throw new Error('Alamat server, kode dan nama player wajib diisi.');
  const serverUrl = serverBase(input.serverUrl.trim());
  const code = input.code.trim(), name = input.name.trim() || os.hostname();
  if (!/^\d{6}$/.test(code)) throw new Error('Kode pemasangan harus enam digit.');
  if (name.length > 120 || /[\u0000-\u001f]/.test(name)) throw new Error('Nama player tidak valid atau terlalu panjang.');
  const dataDir = path.resolve(options.dataDir || process.env.RJ_PLAYER_DATA || path.join(here, 'data'));
  await fs.mkdir(dataDir, { recursive: true });
  await protectData(dataDir);
  const release = await playerLock(dataDir);
  try {
    const configPath = path.join(dataDir, 'config.json');
    const previous = await readJson(configPath);
    if (previous?.token && !options.replace) throw new Error('Player sudah dipasangkan. Gunakan pemasangan ulang secara eksplisit.');
    const response = await fetch(new URL('/api/player/pair', serverUrl), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name }), signal: AbortSignal.timeout(30000),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(response.status === 401 ? 'Kode pemasangan salah atau kedaluwarsa.' : 'Server menolak pemasangan player.');
    if (!safeId(result?.id) || typeof result?.token !== 'string' || result.token.length < 24 || result.token.length > 512) throw new Error('Jawaban pemasangan server tidak valid.');
    // A pending reset suppresses old cached programs if the process dies during re-pairing.
    const resetPath = path.join(dataDir, 'pairing-reset.json');
    await atomicJson(resetPath, { playerId: result.id });
    await atomicJson(configPath, { serverUrl, id: result.id, token: result.token, name });
    await protectData(dataDir, configPath);
    await fs.rm(path.join(dataDir, 'manifest.json'), { force: true });
    await fs.rm(path.join(dataDir, 'media-index.json'), { force: true });
    await fs.rm(resetPath, { force: true });
    return { ok: true, playerId: result.id, name, serverUrl };
  } finally { await release(); }
}

async function streamFile(request, response, filename, mime, knownSize) {
  const stat = await fs.stat(filename), size = knownSize ?? stat.size;
  let start = 0, end = size - 1, code = 200;
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) { response.writeHead(416, { 'Content-Range': `bytes */${size}` }); response.end(); return; }
    if (!match[1]) start = Math.max(0, size - Number(match[2]));
    else start = Number(match[1]);
    if (match[2] && match[1]) end = Math.min(end, Number(match[2]));
    if (start > end || start >= size) { response.writeHead(416, { 'Content-Range': `bytes */${size}` }); response.end(); return; }
    code = 206;
  }
  response.writeHead(code, {
    'Content-Type': mime, 'Content-Length': Math.max(0, end - start + 1), 'Accept-Ranges': 'bytes',
    ...(code === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  });
  if (request.method === 'HEAD' || size === 0) { response.end(); return; }
  await pipeline(createReadStream(filename, { start, end }), response).catch(() => {});
}

/** A local-only player service. Tests can pass port:0, headless:true and a temporary dataDir. */
export async function createPlayer(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.RJ_PLAYER_DATA || path.join(here, 'data'));
  await fs.mkdir(dataDir, { recursive: true });
  const release = await playerLock(dataDir);
  try {
    const player = await createPlayerService({ ...options, dataDir });
    const close = player.close;
    let closing;
    player.close = () => closing ||= close().finally(release);
    return player;
  } catch (error) { await release(); throw error; }
}

async function createPlayerService(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.RJ_PLAYER_DATA || path.join(here, 'data'));
  const legacyCacheDir = path.join(dataDir, 'media');
  const cacheDir = path.resolve(options.mediaDir || legacyCacheDir);
  const config = options.config || await readJson(path.join(dataDir, 'config.json'));
  if (!config?.token || !config?.id || !config?.serverUrl) throw new Error('Player belum dipasangkan. Jalankan: node player/agent.mjs pair');
  const serverUrl = serverBase(config.serverUrl);
  await prepareContentDirectory(legacyCacheDir, cacheDir);
  let activeManifest = await readJson(path.join(dataDir, 'manifest.json'));
  if (await readJson(path.join(dataDir, 'pairing-reset.json'))) activeManifest = null;
  if (activeManifest?.playerId && activeManifest.playerId !== config.id) activeManifest = null;
  let cacheNeedsRepair = false;
  if (activeManifest) {
    for (const asset of activeManifest.assets || []) {
      try {
        if (!safeId(asset.id) || !/^[a-f0-9]{64}$/i.test(asset.sha256 || '')) throw new Error('Invalid cache record.');
        const cachedPath = path.join(cacheDir, asset.sha256.toLowerCase());
        const stat = await fs.stat(cachedPath);
        if (stat.size !== asset.size) throw new Error('Incomplete cache.');
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(cachedPath)) hash.update(chunk);
        if (hash.digest('hex') !== asset.sha256.toLowerCase()) throw new Error('Corrupt cache.');
      } catch { cacheNeedsRepair = true; break; }
    }
    // Never present a known corrupt cold cache as a ready program. Preserve its disk manifest
    // until a complete repair succeeds, then atomically replace it as usual.
    if (cacheNeedsRepair) activeManifest = null;
  }
  const knownAssets = new Map(Object.entries(await readJson(path.join(dataDir, 'media-index.json'), {})));
  if (activeManifest) for (const asset of activeManifest.assets || []) knownAssets.set(asset.id, asset);
  let state = { status: activeManifest ? 'cached' : 'standby', progress: activeManifest ? 100 : 0, currentPublicationId: null,
    downloadedGeneration: activeManifest?.generation || null, lastError: cacheNeedsRepair ? 'Cache tidak lengkap atau rusak; menunggu unduhan ulang.' : '', connected: false, lastSync: null, screen: null,
    playback: { renders: 0, youtube: [] } };
  let syncError = state.lastError, playbackError = '';
  const diagnosticPath = path.join(dataDir, 'logs', 'playback-diagnostic.json');
  const previousDiagnostics = await readJson(diagnosticPath);
  const diagnosticHistory = Array.isArray(previousDiagnostics?.history) ? previousDiagnostics.history.slice(-40).filter(item => item && typeof item === 'object').map(item => ({ at: diagnosticTime(item.at), ...sanitizePlayback(item) })) : [];
  let diagnosticWrite = Promise.resolve();
  let lastPlaybackSignature = playbackSignature(state.playback);
  async function recordPlayback(value) {
    state.playback = sanitizePlayback(value);
    const signature = playbackSignature(state.playback);
    if (signature === lastPlaybackSignature) return;
    lastPlaybackSignature = signature;
    diagnosticHistory.push({ at: new Date().toISOString(), ...state.playback });
    if (diagnosticHistory.length > 40) diagnosticHistory.splice(0, diagnosticHistory.length - 40);
    const snapshot = { schema: 1, history: diagnosticHistory.slice() };
    // Serialize atomic replacements so concurrent renderer reports cannot write
    // an older history over a newer one. Never persist URLs, errors or tokens.
    diagnosticWrite = diagnosticWrite.then(async () => {
      await fs.mkdir(path.dirname(diagnosticPath), { recursive: true });
      await atomicJson(diagnosticPath, snapshot);
    }).catch(() => { /* Diagnostics must not interrupt playback or local status. */ });
    await diagnosticWrite;
  }
  let closed = false, syncPromise = null, queued = false, screenshotBusy = false;
  const timers = new Set(), controllers = new Set();
  let edge = null;
  const authorization = { Authorization: `Bearer ${config.token}` };

  async function api(route, options = {}) {
    const controller = new AbortController(); controllers.add(controller);
    // Keep the abort signal alive for the response body too, including media streams.
    const timer = setTimeout(() => { controller.abort(); controllers.delete(controller); }, options.timeout || 30000);
    timer.unref?.();
    const finish = () => { clearTimeout(timer); controllers.delete(controller); };
    try {
      const response = await fetch(new URL(route, serverUrl), { ...options, headers: { ...authorization, ...options.headers }, signal: controller.signal });
      if (!response.body) { finish(); return response; }
      const reader = response.body.getReader();
      const body = new ReadableStream({
        async pull(output) {
          try {
            const next = await reader.read();
            if (next.done) { finish(); output.close(); }
            else output.enqueue(next.value);
          } catch (error) { finish(); output.error(error); }
        },
        async cancel(reason) { finish(); await reader.cancel(reason); },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { finish(); throw error; }
  }
  async function heartbeat() {
    if (closed) return;
    try {
      const response = await api('/api/player/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: state.status, progress: state.progress, currentPublicationId: state.currentPublicationId,
          downloadedGeneration: state.downloadedGeneration, lastError: state.lastError, screen: state.screen }) });
      await response.arrayBuffer();
      if (!response.ok) throw new Error(response.status === 401 ? 'Akses player ditolak. Periksa pemasangan di dashboard.' : 'Laporan player belum diterima server.');
      state.connected = true;
    } catch { state.connected = false; }
  }

  async function downloadAsset(asset, totalBytes, progress) {
    if (!safeId(asset.id) || !/^[a-f0-9]{64}$/i.test(asset.sha256 || '') || !Number.isSafeInteger(asset.size) || asset.size < 1) throw new Error('Manifest media tidak valid.');
    const destination = path.join(cacheDir, asset.sha256.toLowerCase());
    const cached = await fs.stat(destination).catch(() => null);
    if (cached?.size === asset.size) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(destination)) hash.update(chunk);
      if (hash.digest('hex') === asset.sha256.toLowerCase()) { progress.completed += asset.size; knownAssets.set(asset.id, asset); return; }
    }
    const response = await api(`/api/player/media/${encodeURIComponent(asset.id)}/file`, { timeout: 120000 });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Media belum dapat diunduh (${response.status}).`); }
    const temporary = path.join(cacheDir, `${asset.sha256}.${randomUUID()}.part`);
    const hash = createHash('sha256'); let size = 0, lastReport = 0;
    try {
      await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, encoding, callback) {
        size += chunk.length;
        if (size > asset.size) { callback(new Error('Ukuran unduhan melebihi manifest.')); return; }
        hash.update(chunk); state.progress = Math.min(99, Math.floor((progress.completed + size) / Math.max(totalBytes, 1) * 100));
        if (Date.now() - lastReport > 1000) { lastReport = Date.now(); void heartbeat(); }
        callback(null, chunk);
      } }), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      if (size !== asset.size || hash.digest('hex') !== asset.sha256.toLowerCase()) throw new Error('Pemeriksaan media gagal; tayangan lama tetap dipakai.');
      await fs.rename(temporary, destination); progress.completed += size; knownAssets.set(asset.id, asset);
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }

  async function performSync() {
    if (closed) return;
    try {
      const receivedAt = Date.now();
      const response = await api('/api/player/manifest');
      if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 401 ? 'Akses player ditolak. Periksa pemasangan.' : 'Server belum dapat mengirim tayangan.'); }
      const manifest = await response.json();
      if (manifest.schema !== 1 || typeof manifest.generation !== 'string' || !Array.isArray(manifest.assets) || !Array.isArray(manifest.programs)) throw new Error('Format manifest tidak didukung.');
      state.connected = true;
      const offset = +new Date(manifest.serverTime) - receivedAt;
      manifest.serverOffset = Number.isFinite(offset) ? offset : 0;
      manifest.syncedAt = new Date().toISOString();
      manifest.playerId = config.id;
      if (activeManifest?.generation !== manifest.generation) {
        state.status = 'downloading'; state.progress = 0; await heartbeat();
        const total = manifest.assets.reduce((sum, asset) => sum + Number(asset.size || 0), 0);
        const progress = { completed: 0 };
        for (const asset of manifest.assets) await downloadAsset(asset, total, progress);
        await atomicJson(path.join(dataDir, 'media-index.json'), Object.fromEntries(knownAssets));
      }
      // The current good manifest remains untouched until every referenced file is verified.
      await atomicJson(path.join(dataDir, 'manifest.json'), manifest);
      await fs.rm(path.join(dataDir, 'pairing-reset.json'), { force: true });
      activeManifest = manifest; state.progress = 100; state.downloadedGeneration = manifest.generation;
      if (state.status === 'downloading') state.status = 'ready';
      syncError = ''; state.lastError = playbackError; state.lastSync = manifest.syncedAt; await heartbeat();
    } catch (error) {
      state.connected = false; syncError = error.message || 'Sinkronisasi gagal.'; state.lastError = syncError;
      state.status = activeManifest ? 'cached' : 'error'; await heartbeat();
    }
  }
  async function sync() {
    if (syncPromise) { queued = true; return syncPromise; }
    syncPromise = performSync().finally(() => { syncPromise = null; if (queued && !closed) { queued = false; void sync(); } });
    return syncPromise;
  }

  async function screenshot() {
    if (screenshotBusy || closed) return;
    if (process.platform !== 'win32' || options.headless) { state.lastError = 'Cuplikan layar tersedia pada player Windows dalam mode kios.'; await heartbeat(); return; }
    screenshotBusy = true;
    const filename = path.join(dataDir, `screenshot-${randomUUID()}.png`);
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(windowsPowerShell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'Capture-Player.ps1'), '-OutputPath', filename], { windowsHide: true, stdio: 'ignore', env: windowsPowerShellEnvironment() });
        const timer = setTimeout(() => { child.kill(); reject(new Error('Cuplikan layar melewati batas waktu.')); }, 15000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Cuplikan layar belum dapat diambil.')); });
      });
      const png = await fs.readFile(filename);
      const response = await api('/api/player/screenshot', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png });
      await response.arrayBuffer();
      if (!response.ok) throw new Error('Server menolak cuplikan layar.');
    } catch (error) { state.lastError = error.message; await heartbeat(); }
    finally { screenshotBusy = false; await fs.rm(filename, { force: true }).catch(() => {}); }
  }

  async function events() {
    let delay = 1000;
    while (!closed) {
      const controller = new AbortController(); controllers.add(controller);
      try {
        const response = await fetch(new URL('/api/player/events', serverUrl), { headers: authorization, signal: controller.signal });
        if (!response.ok || !response.body) throw new Error('Push belum tersambung.');
        state.connected = true; delay = 1000; void sync();
        let buffer = '', eventType = '';
        for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
          buffer += chunk;
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1);
            if (line.startsWith('event:')) eventType = line.slice(6).trim();
            else if (!line) {
              if (eventType === 'screenshot') void screenshot();
              else if (eventType === 'update' || eventType === 'hello') void sync();
              eventType = '';
            }
          }
          if (buffer.length > 65536) throw new Error('Pesan push tidak valid.');
          if (closed) break;
        }
      } catch { state.connected = false; }
      finally { controllers.delete(controller); }
      if (!closed) { await sleep(delay); delay = Math.min(delay * 2, 30000); }
    }
  }

  const localServer = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com; style-src 'self' 'unsafe-inline'; img-src 'self'; media-src 'self'; connect-src 'self'; frame-src https://www.youtube.com https://www.youtube-nocookie.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const host = request.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) { json(response, 403, { error: 'Host tidak diizinkan.' }); return; }
    if (request.headers.origin && request.headers.origin !== `http://${host}`) { json(response, 403, { error: 'Origin tidak diizinkan.' }); return; }
    const url = new URL(request.url, `http://${host}`);
    try {
      if (request.method === 'GET' && url.pathname === '/api/local/manifest') { json(response, 200, activeManifest || { schema: 1, generation: 'empty', settings: {}, programs: [], schedules: [], assets: [] }); return; }
      if (request.method === 'GET' && url.pathname === '/api/local/status') { json(response, 200, { application: 'RJDigitalSignagePlayer', version: '0.3.2', ...state, playerId: config.id, playerName: config.name || '', contentDirectory: cacheDir }); return; }
      if (request.method === 'POST' && url.pathname === '/api/local/status') {
        if (request.headers['x-rj-request'] !== '1') { json(response, 403, { error: 'Permintaan ditolak.' }); return; }
        let body = '';
        for await (const chunk of request) { body += chunk; if (body.length > 16384) throw new Error('Laporan terlalu besar.'); }
        const report = JSON.parse(body);
        const allowed = ['playing', 'waiting-video', 'standby'];
        if (allowed.includes(report.status) && state.status !== 'downloading') state.status = report.status;
        if (typeof report.currentPublicationId === 'string' || report.currentPublicationId === null) state.currentPublicationId = report.currentPublicationId;
        if (typeof report.lastError === 'string') { playbackError = report.lastError.slice(0, 500); state.lastError = syncError || playbackError; }
        if (report.screen && Number.isFinite(report.screen.width) && Number.isFinite(report.screen.height)) state.screen = { width: report.screen.width, height: report.screen.height };
        if (report.playback && typeof report.playback === 'object' && !Array.isArray(report.playback)) await recordPlayback(report.playback);
        json(response, 200, { ok: true }); return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) { json(response, 405, { error: 'Metode tidak diizinkan.' }); return; }
      const media = /^\/media\/([a-zA-Z0-9_-]{1,120})\/file$/.exec(url.pathname);
      if (media) {
        const asset = knownAssets.get(media[1]);
        if (!asset) { json(response, 404, { error: 'Media belum tersedia.' }); return; }
        await streamFile(request, response, path.join(cacheDir, asset.sha256.toLowerCase()), asset.mime || 'application/octet-stream', asset.size); return;
      }
      const staticFiles = {
        '/': ['public/player.html', 'text/html; charset=utf-8'], '/player.html': ['public/player.html', 'text/html; charset=utf-8'],
        '/player.js': ['public/player.js', 'text/javascript; charset=utf-8'], '/player.css': ['public/player.css', 'text/css; charset=utf-8'],
        '/shared/renderer.mjs': ['shared/renderer.mjs', 'text/javascript; charset=utf-8'],
        '/shared/youtube.mjs': ['shared/youtube.mjs', 'text/javascript; charset=utf-8'],
        '/shared/program.mjs': ['shared/program.mjs', 'text/javascript; charset=utf-8'],
        '/shared/prayer.mjs': ['shared/prayer.mjs', 'text/javascript; charset=utf-8'],
        '/brand/logo.png': ['branding/RJ-Digital-Signage-System-logo-approved-v1.png', 'image/png'],
      };
      const file = staticFiles[url.pathname];
      if (!file) { json(response, 404, { error: 'Tidak ditemukan.' }); return; }
      response.setHeader('Cache-Control', 'no-cache');
      await streamFile(request, response, path.join(project, file[0]), file[1]);
    } catch {
      if (!response.headersSent) json(response, 400, { error: 'Permintaan player tidak dapat diproses.' });
      else response.destroy();
    }
  });
  await new Promise((resolve, reject) => { localServer.once('error', reject); localServer.listen(options.port ?? Number(process.env.RJ_PLAYER_PORT || 3211), '127.0.0.1', resolve); });
  const address = `http://127.0.0.1:${localServer.address().port}`;

  async function launchEdge() {
    if (closed || options.headless || process.platform !== 'win32') return;
    const choices = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).map(folder => path.join(folder, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    const executable = (await Promise.all(choices.map(async candidate => await fs.access(candidate).then(() => candidate).catch(() => null)))).find(Boolean);
    if (!executable) { state.lastError = 'Microsoft Edge belum tersedia. Pasang Edge untuk mode kios.'; return; }
    const launched = spawn(executable, ['--kiosk', `${address}/player.html`, '--edge-kiosk-type=fullscreen', '--no-first-run', '--autoplay-policy=no-user-gesture-required', `--user-data-dir=${path.join(dataDir, 'kiosk-profile')}`], { windowsHide: true, stdio: 'ignore' });
    edge = launched;
    launched.once('error', () => { state.lastError = 'Player layar penuh belum dapat dibuka.'; });
    launched.once('close', () => {
      if (edge === launched) edge = null;
      if (!closed) { const timer = setTimeout(() => { timers.delete(timer); void launchEdge(); }, 5000); timers.add(timer); }
    });
  }
  if (options.connect !== false) {
    void sync(); void events();
    timers.add(setInterval(() => void sync(), 60000)); timers.add(setInterval(() => void heartbeat(), 10000));
  }
  void launchEdge();
  return {
    server: localServer, address, dataDir, mediaDir: cacheDir, sync,
    get manifest() { return activeManifest; }, get status() { return { ...state }; },
    async close() {
      closed = true; for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }
      for (const controller of controllers) controller.abort();
      const ownedEdge = edge; edge = null;
      if (ownedEdge && ownedEdge.exitCode === null && ownedEdge.pid) {
        if (process.platform === 'win32') {
          await new Promise(resolve => {
            const stop = spawn('taskkill.exe', ['/PID', String(ownedEdge.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            const timer = setTimeout(() => { stop.kill(); resolve(); }, 3000);
            const done = () => { clearTimeout(timer); resolve(); };
            stop.once('error', done); stop.once('exit', done);
          });
        } else ownedEdge.kill();
      }
      localServer.closeAllConnections?.(); await new Promise(resolve => localServer.close(resolve));
      if (syncPromise) await syncPromise;
      await diagnosticWrite;
    },
  };
}

async function cli() {
  const args = process.argv.slice(2);
  const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const dataDir = path.resolve(value('--data-dir') || process.env.RJ_PLAYER_DATA || path.join(here, 'data'));
  if (args[0] === 'pair') {
    if (args.includes('--json')) {
      let text = '';
      for await (const chunk of process.stdin) { text += chunk; if (text.length > 16384) throw new Error('Data pemasangan terlalu besar.'); }
      let input;
      try { input = JSON.parse(text); } catch { throw new Error('Data pemasangan harus JSON yang valid.'); }
      console.log(JSON.stringify(await pairPlayer(input, { dataDir, replace: args.includes('--replace') })));
      return;
    }
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const serverUrl = serverBase((await input.question('Alamat server (contoh http://192.168.1.10:3210): ')).trim());
      const code = (await input.question('Kode pemasangan enam digit: ')).trim();
      const name = (await input.question('Nama player: ')).trim() || os.hostname();
      await pairPlayer({ serverUrl, code, name }, { dataDir, replace: args.includes('--replace') });
      console.log('Player berhasil dipasangkan. Kredensial disimpan lokal dan tidak ditampilkan.');
    } finally { input.close(); }
    return;
  }
  let control, stopRequested = false, requestStop;
  if (args.includes('--supervised')) {
    control = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const start = await new Promise(resolve => {
      let started = false;
      control.on('line', line => {
        try {
          const message = JSON.parse(line);
          if (message.command === 'start' && !started && !stopRequested) { started = true; resolve(true); }
          else if (message.command === 'shutdown') { stopRequested = true; if (requestStop) requestStop(); else if (!started) resolve(false); }
        } catch { /* Ignore malformed local supervisor messages. */ }
      });
      control.once('close', () => { stopRequested = true; if (requestStop) requestStop(); else if (!started) resolve(false); });
    });
    if (!start) { control.close(); return; }
  }
  let player;
  try { player = await createPlayer({ dataDir, mediaDir: value('--media-dir') || process.env.RJ_PLAYER_MEDIA, port: value('--port') ? Number(value('--port')) : undefined, headless: args.includes('--headless') }); }
  catch (error) { control?.close(); throw error; }
  let stopping = false;
  const stop = () => { if (!stopping) { stopping = true; player.close().finally(() => process.exit(0)); } };
  requestStop = stop;
  if (stopRequested) { stop(); return; }
  if (args.includes('--supervised')) {
    console.log(JSON.stringify({ event: 'ready', address: player.address }));
  } else console.log(`RJ Player aktif di ${player.address}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli().catch(error => {
  const message = error.code === 'EADDRINUSE' ? 'Port player sudah digunakan. Tutup player sebelumnya atau periksa port 3211.' : error.message || 'Player gagal dimulai.';
  console.error(process.argv.includes('--json') ? JSON.stringify({ ok: false, error: message }) : message); process.exitCode = 1;
});
