const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;

/** Normalize a direct video/live link without fetching arbitrary URLs or retaining tracking parameters. */
export function normalizeYouTubeUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Masukkan tautan video atau siaran langsung YouTube.');
  const raw = value.trim();
  if (!raw || /[\u0000-\u0020\u007f\\]/.test(raw)) throw new Error('Tautan YouTube tidak valid.');
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('Tautan YouTube harus berupa alamat HTTP/HTTPS lengkap.'); }
  const authority = raw.match(/^https?:\/\/([^/?#]+)/i)?.[1] || '';
  if (!['http:', 'https:'].includes(parsed.protocol) || !authority || /[:@]/.test(authority) || parsed.username || parsed.password || parsed.port) {
    throw new Error('Gunakan tautan YouTube tanpa nama pengguna, password, atau port tambahan.');
  }
  const host = parsed.hostname.replace(/^(?:www\.|m\.)/, '');
  let videoId;
  if (host === 'youtu.be') videoId = parsed.pathname.match(/^\/([A-Za-z0-9_-]{11})\/?$/)?.[1];
  else if (host === 'youtube.com') {
    if (parsed.pathname === '/watch' && parsed.searchParams.getAll('v').length === 1) videoId = parsed.searchParams.get('v');
    else videoId = parsed.pathname.match(/^\/(?:live|embed)\/([A-Za-z0-9_-]{11})\/?$/)?.[1];
  } else if (host === 'youtube-nocookie.com') videoId = parsed.pathname.match(/^\/embed\/([A-Za-z0-9_-]{11})\/?$/)?.[1];
  if (!videoIdPattern.test(videoId || '')) throw new Error('Gunakan link video/live YouTube langsung, bukan link channel atau playlist.');
  return { videoId, url: `https://www.youtube.com/watch?v=${videoId}` };
}

let apiLoad = null, iframeSequence = 0;

function acquireApi(timeoutMs) {
  if (typeof window.YT?.Player === 'function') return { promise: Promise.resolve(window.YT), release() {} };
  let state = apiLoad;
  if (!state) {
    state = { users: 0, pending: true };
    state.promise = new Promise((resolve, reject) => { state.resolve = resolve; state.reject = reject; });
    apiLoad = state;
    const previous = window.onYouTubeIframeAPIReady;
    const script = document.createElement('script');
    script.id = 'rj-youtube-api'; script.src = 'https://www.youtube.com/iframe_api'; script.async = true;
    script.referrerPolicy = 'strict-origin-when-cross-origin';
    const finish = (error) => {
      if (!state.pending) return;
      state.pending = false; clearTimeout(state.timer);
      script.removeEventListener('error', failed); script.removeEventListener('load', loaded);
      if (window.onYouTubeIframeAPIReady === ready) window.onYouTubeIframeAPIReady = previous;
      if (apiLoad === state) apiLoad = null;
      if (error) { script.remove(); state.reject(error); } else state.resolve(window.YT);
    };
    const ready = () => {
      try { if (typeof previous === 'function') previous(); } catch { /* Another consumer cannot prevent our cleanup. */ }
      if (typeof window.YT?.Player === 'function') finish();
    };
    const loaded = () => { if (typeof window.YT?.Player === 'function') finish(); };
    const failed = () => finish(new Error('YouTube belum dapat dimuat.'));
    state.cancel = () => finish(new Error('Pemuatan YouTube dibatalkan.'));
    window.onYouTubeIframeAPIReady = ready;
    script.addEventListener('error', failed); script.addEventListener('load', loaded);
    state.timer = setTimeout(failed, timeoutMs);
    document.getElementById(script.id)?.remove(); document.head.append(script);
  }
  state.users++;
  let released = false;
  return { promise: state.promise, release() {
    if (released) return; released = true; state.users--;
    if (!state.users && state.pending) state.cancel();
  } };
}

const milliseconds = (value, fallback) => Number.isFinite(Number(value)) ? Math.max(10, Math.min(300000, Number(value))) : fallback;
const boundedVolume = value => Math.max(0, Math.min(1, Number.isFinite(Number(value)) ? Number(value) : 1));

/** A lazy external embed. Its local fallback never joins the file-video transition boundary. */
export function mountYouTubeWidget(box, widget, options = {}) {
  const timing = options.youtubeTiming || {};
  const apiTimeout = milliseconds(timing.apiTimeoutMs, 30000), startupTimeout = milliseconds(timing.startupTimeoutMs, 60000);
  const bufferTimeout = milliseconds(timing.bufferTimeoutMs, 60000), retryDelay = milliseconds(timing.retryMs, 30000);
  let destroyed = false, attempt = 0, player = null, frame = null, apiLease = null;
  let retryTimer = null, startupTimer = null, bufferTimer = null, fallbackCleanup = null;
  let state = '', reason = '', lastReport = '', ended = false, normalized, errorCode = null;
  const report = message => { if (message !== lastReport) { lastReport = message; options.onError?.(message, widget); } };
  const setState = (next, why = '') => {
    state = next; reason = why; box.dataset.youtubeState = next; box.dataset.youtubeReason = why;
    const rect = box.getBoundingClientRect();
    options.onYouTubeState?.(next, widget, why, { attempt, code: errorCode, at: new Date().toISOString(),
      width: Math.round(rect.width), height: Math.round(rect.height) });
  };
  const visibleSize = () => { const rect = box.getBoundingClientRect(); return rect.width >= 200 && rect.height >= 200; };
  const messageNode = message => {
    const node = document.createElement('div'); node.className = 'rj-youtube-message'; node.textContent = message;
    Object.assign(node.style, { width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '1em', boxSizing: 'border-box', background: '#0b1739', color: '#d6e9eb', fontSize: '24px', lineHeight: '1.4', whiteSpace: 'pre-line' });
    return node;
  };
  function clearView() {
    clearTimeout(startupTimer); clearTimeout(bufferTimer); startupTimer = null; bufferTimer = null;
    apiLease?.release(); apiLease = null;
    const owned = player; player = null;
    try { owned?.destroy(); } catch { /* Remove only this widget's frame below. */ }
    frame?.remove(); frame = null;
    fallbackCleanup?.(); fallbackCleanup = null;
    box.replaceChildren();
  }
  function localFallback(message) {
    const host = document.createElement('div'); host.className = 'rj-youtube-fallback';
    Object.assign(host.style, { width: '100%', height: '100%', background: '#0b1739' }); box.append(host);
    if (!widget.fallbackMediaId) { host.append(messageNode(message)); return; }
    let source;
    try {
      source = new URL((options.mediaUrl || (id => `/api/media/${encodeURIComponent(id)}/file`))(widget.fallbackMediaId), location.href);
      if (source.origin !== location.origin || !['http:', 'https:'].includes(source.protocol)) throw new Error('Cadangan bukan media lokal.');
    } catch { host.append(messageNode(message)); return; }
    const kind = options.mediaKind?.(widget.fallbackMediaId) || 'image';
    const media = document.createElement(kind === 'video' ? 'video' : 'img');
    media.dataset.fallbackMediaId = widget.fallbackMediaId;
    Object.assign(media.style, { width: '100%', height: '100%', display: 'block', objectFit: 'contain' });
    const failed = () => { if (destroyed || host.parentNode !== box) return; host.replaceChildren(messageNode(message)); report('Konten cadangan YouTube belum dapat diputar.'); };
    media.addEventListener('error', failed);
    if (kind === 'video') {
      media.autoplay = true; media.playsInline = true; media.loop = true; media.preload = 'auto';
      media.muted = widget.muted !== false; media.volume = boundedVolume(widget.volume);
    } else media.alt = '';
    host.append(media); media.src = source.href;
    if (kind === 'video') media.play().catch(failed);
    fallbackCleanup = () => {
      media.removeEventListener('error', failed);
      if (kind === 'video') { media.pause(); media.removeAttribute('src'); media.load(); }
      else media.removeAttribute('src');
    };
  }
  function fallback(message, why, retry = true) {
    if (destroyed) return;
    attempt++; clearTimeout(retryTimer); retryTimer = null; clearView();
    setState('fallback', why); localFallback(message); report(message);
    if (retry && navigator.onLine !== false && !ended) retryTimer = setTimeout(begin, retryDelay);
  }
  function begin() {
    if (destroyed || options.static || !normalized || ended) return;
    if (options.youtubeBlockedReason) { fallback(options.youtubeBlockedReason, 'obscured', false); return; }
    if (!visibleSize()) { fallback('Area YouTube minimal 200 × 200 piksel pada layar.', 'size', false); return; }
    if (navigator.onLine === false) { fallback('Siaran langsung sedang tidak tersambung.', 'offline', false); return; }
    const current = ++attempt; errorCode = null;
    clearTimeout(retryTimer); retryTimer = null; clearView();
    setState('connecting'); localFallback('Menghubungkan siaran langsung…');
    apiLease = acquireApi(apiTimeout);
    apiLease.promise.then(api => {
      if (destroyed || current !== attempt) return;
      apiLease?.release(); apiLease = null;
      if (!visibleSize()) { fallback('Area YouTube minimal 200 × 200 piksel pada layar.', 'size', false); return; }
      fallbackCleanup?.(); fallbackCleanup = null;
      frame = document.createElement('iframe'); frame.id = `rj-youtube-${++iframeSequence}`;
      frame.className = 'rj-youtube-embed'; frame.title = 'YouTube Live'; frame.allow = 'autoplay; encrypted-media; fullscreen'; frame.allowFullscreen = true;
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      Object.assign(frame.style, { width: '100%', height: '100%', border: '0', display: 'block' });
      const source = new URL(`https://www.youtube-nocookie.com/embed/${normalized.videoId}`);
      for (const [key, value] of Object.entries({ enablejsapi: '1', origin: location.origin, playsinline: '1', autoplay: '0' })) source.searchParams.set(key, value);
      frame.src = source.href; box.replaceChildren(frame);
      const active = () => !destroyed && current === attempt;
      const unavailable = (message, why, retry = true) => { if (active()) fallback(message, why, retry); };
      startupTimer = setTimeout(() => unavailable('Siaran belum tersedia. Menampilkan tayangan cadangan.', 'startup'), startupTimeout);
      try {
        const created = new api.Player(frame, { host: 'https://www.youtube-nocookie.com', width: '100%', height: '100%', videoId: normalized.videoId,
          events: {
            onReady(event) {
              if (!active()) return;
              try {
                const target = event.target || player;
                if (widget.muted !== false) target.mute(); else target.unMute();
                target.setVolume(Math.round(boundedVolume(widget.volume) * 100)); target.playVideo();
              } catch { unavailable('Siaran belum dapat diputar otomatis.', 'autoplay'); }
            },
            onStateChange(event) {
              if (!active()) return;
              if (event.data === 1) {
                clearTimeout(startupTimer); clearTimeout(bufferTimer); startupTimer = null; bufferTimer = null;
                setState('playing'); lastReport = ''; options.onRecovery?.(widget);
              } else if (event.data === 0) {
                ended = true; unavailable('Siaran langsung telah berakhir.', 'ended', false);
              } else if ([3, 2, -1, 5].includes(event.data)) {
                // Buffering and pre-roll are not embed errors. Keep the current frame
                // alive so YouTube can recover instead of restarting its connection.
                setState(event.data === 3 ? 'buffering' : event.data === 2 ? 'paused' : 'connecting');
                if (!bufferTimer) bufferTimer = setTimeout(() => {
                  bufferTimer = null;
                  if (!active()) return;
                  let recovered = false;
                  try { recovered = player?.getPlayerState() === 1; } catch { /* A broken API falls back below. */ }
                  if (recovered) {
                    clearTimeout(startupTimer); startupTimer = null;
                    setState('playing'); lastReport = ''; options.onRecovery?.(widget);
                  } else unavailable('Siaran terputus. Menampilkan tayangan cadangan.', 'buffering');
                }, bufferTimeout);
              }
            },
            onError(event) {
              if (!active()) return;
              errorCode = Number.isFinite(Number(event.data)) ? Number(event.data) : null;
              const messages = { 100: 'Siaran tidak tersedia atau belum dimulai.', 101: 'Pemilik siaran tidak mengizinkan pemutaran di aplikasi lain.', 150: 'Pemilik siaran tidak mengizinkan pemutaran di aplikasi lain.', 153: 'YouTube menolak identitas player. Periksa koneksi dan izin embed.' };
              unavailable(messages[event.data] || 'Siaran YouTube belum dapat diputar.', 'error');
            },
            onAutoplayBlocked() { unavailable('Siaran belum dapat diputar otomatis.', 'autoplay'); },
          },
        });
        if (active()) player = created; else { try { created.destroy(); } catch { /* Stale constructor callback already cleaned the frame. */ } }
      } catch { unavailable('Siaran YouTube belum dapat dimuat.', 'api'); }
    }).catch(() => { if (!destroyed && current === attempt) fallback('Siaran YouTube belum dapat dimuat.', 'api'); });
  }
  // Windows may repeat online notifications. Never replace a frame that is
  // already connecting/buffering/playing just because connectivity was reported.
  const online = () => { if (!ended && state === 'fallback' && reason === 'offline') begin(); };
  const offline = () => fallback('Siaran langsung sedang tidak tersambung.', 'offline', false);
  const checkSize = () => {
    if (destroyed || options.static || ended || !normalized) return;
    if (!visibleSize()) { if (reason !== 'size') fallback('Area YouTube minimal 200 × 200 piksel pada layar.', 'size', false); }
    else if (reason === 'size') begin();
  };
  const resize = new ResizeObserver(checkSize);
  try { normalized = normalizeYouTubeUrl(widget.youtubeUrl); } catch { /* Invalid drafts use a local placeholder. */ }
  if (options.static) {
    setState('static'); box.append(messageNode(normalized ? 'YouTube Live\nPratinjau melalui tombol Pratinjau' : 'YouTube Live\nIsi link siaran di properti elemen'));
  } else if (!normalized) fallback('Tautan YouTube belum diisi atau tidak valid.', 'url', false);
  else { addEventListener('online', online); addEventListener('offline', offline); addEventListener('resize', checkSize); resize.observe(box); begin(); }
  return { refresh: checkSize, destroy() {
    if (destroyed) return; destroyed = true; attempt++;
    clearTimeout(retryTimer); retryTimer = null; clearView(); resize.disconnect();
    removeEventListener('online', online); removeEventListener('offline', offline); removeEventListener('resize', checkSize);
  } };
}
