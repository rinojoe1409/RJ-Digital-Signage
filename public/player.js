import { mountRenderer } from '/shared/renderer.mjs';
import { resolveProgram, playbackKey } from '/shared/program.mjs';

const screen = document.querySelector('#screen');
const standby = document.querySelector('#standby');
const standbyMessage = document.querySelector('#standby-message');
const preview = new URLSearchParams(location.search).get('preview');
if (preview) document.querySelector('#preview-badge').hidden = false;
document.querySelector('#fullscreen').addEventListener('click', () => document.documentElement.requestFullscreen?.());
let manifest = null, rendering = null, currentKey = '', currentPublicationId = null;
let waiting = false, lastError = '', alive = true;
let renderCount = 0;
const youtube = new Map();

function now() { return new Date(Date.now() + (Number(manifest?.serverOffset) || 0)); }
function reportStatus(status) {
  if (preview || !alive) return;
  fetch('/api/local/status', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-RJ-Request': '1' }, body: JSON.stringify({
    currentPublicationId, status, lastError, screen: { width: innerWidth, height: innerHeight },
    playback: { renders: renderCount, youtube: [...youtube.values()] },
  }) }).catch(() => {});
}

function showProgram(publication) {
  rendering?.destroy(); rendering = null; waiting = false; youtube.clear();
  currentPublicationId = publication?.id || null;
  currentKey = playbackKey(manifest, publication);
  if (!publication) {
    standby.hidden = false; standbyMessage.textContent = 'Player siap · belum ada tayangan yang diterbitkan.';
    reportStatus('standby'); return;
  }
  standby.hidden = true; lastError = ''; renderCount++;
  rendering = mountRenderer(screen, publication.layout, {
    mediaUrl: id => preview ? `/api/media/${encodeURIComponent(id)}/file` : `/media/${encodeURIComponent(id)}/file`,
    mediaKind: id => manifest.assets?.find(asset => asset.id === id)?.kind,
    settings: manifest.settings || {}, serverOffset: Number(manifest.serverOffset) || 0,
    onError(message) { lastError = message; reportStatus(waiting ? 'waiting-video' : 'playing'); },
    onRecovery() { lastError = ''; reportStatus(waiting ? 'waiting-video' : 'playing'); },
    onYouTubeState(next, widget, reason, details) {
      youtube.set(widget.id, { widgetId: widget.id, state: next, reason, ...details });
      reportStatus(waiting ? 'waiting-video' : 'playing');
    },
  });
  reportStatus('playing');
}

function evaluateProgram() {
  if (!manifest) return;
  const publication = resolveProgram(manifest, now());
  const desiredKey = playbackKey(manifest, publication);
  if (desiredKey === currentKey || waiting) return;
  if (!rendering) { showProgram(publication); return; }
  waiting = true; reportStatus('waiting-video');
  rendering.requestStopAfterVideos(() => {
    showProgram(resolveProgram(manifest, now()));
  });
}

async function refreshManifest() {
  try {
    const url = preview ? `/api/preview/manifest?id=${encodeURIComponent(preview)}` : '/api/local/manifest';
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(response.status === 401 ? 'Masuk ke dashboard untuk melihat pratinjau.' : 'Manifest belum tersedia.');
    const received = await response.json();
    if (!received?.schema) throw new Error('Manifest belum siap.');
    if (preview) received.serverOffset = +new Date(received.serverTime) - Date.now();
    manifest = received; evaluateProgram();
  } catch (error) {
    if (!manifest) standbyMessage.textContent = error.message || 'Menunggu konten player…';
  }
}
refreshManifest();
const refresh = setInterval(refreshManifest, preview ? 4000 : 2000);
const scheduling = setInterval(evaluateProgram, 1000);
const reporting = setInterval(() => reportStatus(waiting ? 'waiting-video' : rendering ? 'playing' : 'standby'), 5000);
addEventListener('beforeunload', () => { alive = false; clearInterval(refresh); clearInterval(scheduling); clearInterval(reporting); rendering?.destroy(); });
