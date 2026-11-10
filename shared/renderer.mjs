import { getPrayerTimes } from './prayer.mjs';
import { mountYouTubeWidget } from './youtube.mjs';

const number = (value, fallback, minimum = -Infinity, maximum = Infinity) =>
  Math.max(minimum, Math.min(maximum, Number.isFinite(Number(value)) ? Number(value) : fallback));

/** Shared renderer for the editor, preview and cached Windows player. Never injects HTML. */
export function mountRenderer(container, layout, options = {}) {
  const width = number(layout.width, 1920, 100, 16384), height = number(layout.height, 1080, 100, 16384);
  const wrapper = document.createElement('div');
  wrapper.className = 'rj-renderer';
  Object.assign(wrapper.style, { position: 'absolute', inset: '0', overflow: 'hidden', background: '#050a14' });
  const stage = document.createElement('div');
  stage.className = 'rj-stage';
  Object.assign(stage.style, {
    position: 'absolute', width: `${width}px`, height: `${height}px`, left: '50%', top: '50%',
    transformOrigin: 'center center', overflow: 'hidden', background: layout.background || '#0c1731',
    fontFamily: 'Segoe UI, Arial, sans-serif', color: '#fff',
  });
  wrapper.append(stage); container.append(wrapper);
  let destroyed = false, stopRequested = false, stoppedCallback = null, stopCheck = null;
  const cleanups = [], videos = [], youtubeWidgets = [];
  const clock = () => new Date(Date.now() + (Number(options.serverOffset) || 0));
  const mediaUrl = options.mediaUrl || (id => `/api/media/${encodeURIComponent(id)}/file`);
  const report = (message, widget) => options.onError?.(message, widget);
  const resize = () => {
    const scale = Math.min(container.clientWidth / width, container.clientHeight / height) || 1;
    stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
    for (const youtube of youtubeWidgets) youtube.refresh();
  };
  const observer = new ResizeObserver(resize); observer.observe(container); resize();
  cleanups.push(() => observer.disconnect());

  function checkStopped() {
    if (!stopRequested || !stoppedCallback || destroyed) return;
    const now = Date.now();
    for (const record of videos) {
      if (!record.done && !record.failed && now - record.lastProgress > 15000) {
        record.failed = true;
        record.element.pause();
        report('Video tidak merespons; berpindah ke tayangan berikutnya.', record.widget);
      }
    }
    if (videos.every(record => record.done || record.failed)) {
      const callback = stoppedCallback; stoppedCallback = null;
      clearInterval(stopCheck); stopCheck = null;
      queueMicrotask(() => { if (!destroyed) callback(); });
    }
  }

  const orderedWidgets = [...(layout.widgets || [])].sort((a, b) => number(a.z, 0) - number(b.z, 0));
  let youtubeCount = 0;
  for (const [widgetIndex, widget] of orderedWidgets.entries()) {
    if (widget.enabled === false) continue;
    const box = document.createElement('div');
    box.className = `rj-widget rj-widget-${widget.type}`;
    box.dataset.widgetId = widget.id;
    Object.assign(box.style, {
      position: 'absolute', left: `${number(widget.x, 0)}px`, top: `${number(widget.y, 0)}px`,
      width: `${number(widget.width, 400, 1)}px`, height: `${number(widget.height, 100, 1)}px`,
      overflow: 'hidden', boxSizing: 'border-box', background: widget.background || 'transparent',
      color: widget.color || '#ffffff', fontSize: `${number(widget.fontSize, 40, 8, 600)}px`,
      fontWeight: String(widget.fontWeight || 400), textAlign: widget.align || 'left',
      borderRadius: `${number(widget.borderRadius, 0, 0)}px`,
    });
    stage.append(box);

    if (widget.type === 'text') {
      Object.assign(box.style, { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: '1.25' });
      box.textContent = widget.text || '';
    } else if (widget.type === 'image') {
      const image = document.createElement('img'); image.alt = widget.name || '';
      Object.assign(image.style, { width: '100%', height: '100%', display: 'block', objectFit: widget.fit || 'contain' });
      const items = widget.playlist?.length ? widget.playlist : [{ mediaId: widget.mediaId }];
      let index = 0, imageTimer;
      const showImage = () => {
        if (destroyed) return;
        const item = items[index];
        if (item?.mediaId) image.src = mediaUrl(item.mediaId);
        index = (index + 1) % items.length;
        if (items.length > 1) imageTimer = setTimeout(showImage, number(item?.duration, 10, 1, 86400) * 1000);
      };
      image.addEventListener('error', () => report('Gambar tidak dapat diputar.', widget));
      box.append(image); showImage(); cleanups.push(() => clearTimeout(imageTimer));
    } else if (widget.type === 'video') {
      if (options.static) {
        box.classList.add('rj-video-placeholder');
        Object.assign(box.style, { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1em', textAlign: 'center', background: '#0b1739', color: '#d6e9eb' });
        box.textContent = Array.isArray(widget.playlist) ? `Playlist video · ${widget.playlist.length} video` : 'Video';
        continue;
      }
      const video = document.createElement('video');
      video.autoplay = true; video.playsInline = true; video.preload = 'auto'; video.loop = false;
      video.muted = widget.muted !== false; video.volume = number(widget.volume, 1, 0, 1);
      Object.assign(video.style, { width: '100%', height: '100%', display: 'block', objectFit: widget.fit || 'contain' });
      const record = { element: video, widget, done: false, failed: false, lastProgress: Date.now(), lastTime: 0 };
      videos.push(record);
      const items = Array.isArray(widget.playlist) ? widget.playlist : [{ mediaId: widget.mediaId }];
      if (!items.length) {
        record.failed = true;
        box.classList.add('rj-playlist-empty');
        Object.assign(box.style, { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1em', textAlign: 'center', background: '#0b1739', color: '#d6e9eb' });
        box.textContent = 'Tambahkan video ke playlist.';
        continue;
      }
      let index = 0, playAttempt = 0;
      const fail = error => {
        if (destroyed) return;
        const code = video.error?.code;
        const reasons = {
          1: 'pemutaran terhenti',
          2: 'berkas video tidak dapat dibaca',
          3: 'isi video gagal diproses oleh pemutar',
          4: 'format atau sumber video tidak didukung',
        };
        const detail = reasons[code] ? `${reasons[code]} (kode ${code})`
          : error?.name === 'NotAllowedError' ? 'pemutaran otomatis atau suara diblokir browser'
          : error?.name === 'NotSupportedError' ? 'format video tidak didukung'
          : error?.name === 'AbortError' ? 'pemutaran dibatalkan sebelum mulai'
          : 'periksa format dan izin suara';
        record.failed = true; report(`Video gagal diputar: ${detail}.`, widget); checkStopped();
      };
      const startVideo = () => {
        if (destroyed || stopRequested) return;
        const item = items[index];
        if (!item?.mediaId) { fail(); return; }
        record.done = false; record.failed = false; record.lastProgress = Date.now(); record.lastTime = 0;
        video.muted = typeof item.muted === 'boolean' ? item.muted : widget.muted !== false;
        video.src = mediaUrl(item.mediaId);
        const attempt = ++playAttempt;
        video.play().catch(error => { if (attempt === playAttempt && !destroyed) fail(error); });
      };
      video.addEventListener('timeupdate', () => {
        if (Math.abs(video.currentTime - record.lastTime) > 0.02) { record.lastTime = video.currentTime; record.lastProgress = Date.now(); }
      });
      video.addEventListener('playing', () => { record.lastProgress = Date.now(); });
      video.addEventListener('error', fail);
      video.addEventListener('ended', () => {
        options.onVideoBoundary?.(widget.id);
        if (stopRequested) { record.done = true; checkStopped(); }
        else { index = (index + 1) % items.length; startVideo(); }
      });
      box.append(video); startVideo();
      cleanups.push(() => { video.pause(); video.removeAttribute('src'); video.load(); });
    } else if (widget.type === 'youtube') {
      youtubeCount++;
      box.style.borderRadius = '0';
      const outOfBounds = number(widget.x, 0) < 0 || number(widget.y, 0) < 0
        || number(widget.x, 0) + number(widget.width, 400, 1) > width
        || number(widget.y, 0) + number(widget.height, 100, 1) > height;
      const overlap = orderedWidgets.slice(widgetIndex + 1).some(other => other.enabled !== false
        && number(other.x, 0) < number(widget.x, 0) + number(widget.width, 400, 1)
        && number(other.x, 0) + number(other.width, 400, 1) > number(widget.x, 0)
        && number(other.y, 0) < number(widget.y, 0) + number(widget.height, 100, 1)
        && number(other.y, 0) + number(other.height, 100, 1) > number(widget.y, 0));
      const youtube = mountYouTubeWidget(box, widget, { ...options,
        mediaUrl,
        youtubeBlockedReason: youtubeCount > 1 ? 'Gunakan satu siaran YouTube aktif pada setiap layout.' : outOfBounds ? 'Tempatkan seluruh area YouTube di dalam kanvas.' : overlap ? 'Area YouTube tertutup elemen lain. Pisahkan area siaran dan elemen lain.' : '',
        onError: message => report(message, widget),
      });
      youtubeWidgets.push(youtube);
      cleanups.push(() => youtube.destroy());
    } else if (widget.type === 'ticker') {
      Object.assign(box.style, { display: 'flex', alignItems: 'center' });
      const text = document.createElement('span'); text.textContent = widget.text || '';
      Object.assign(text.style, { display: 'block', whiteSpace: 'pre', flexShrink: '0', willChange: 'transform' });
      box.append(text);
      const distance = number(widget.width, 800) + Math.max(text.scrollWidth, 1);
      const animation = text.animate([
        { transform: `translateX(${number(widget.width, 800)}px)` }, { transform: `translateX(-${text.scrollWidth}px)` },
      ], { duration: distance / number(widget.speed, 80, 1, 2000) * 1000, iterations: Infinity, easing: 'linear' });
      cleanups.push(() => animation.cancel());
    } else if (widget.type === 'clock') {
      Object.assign(box.style, { display: 'flex', flexDirection: 'column', justifyContent: 'center', lineHeight: '1.25' });
      const time = document.createElement('div'), date = document.createElement('div');
      date.style.fontSize = '0.4em'; date.style.marginTop = '0.25em';
      box.append(time, date);
      const updateClock = () => {
        time.textContent = new Intl.DateTimeFormat('id-ID', { timeZone: options.settings?.timezone || 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(clock());
        date.textContent = new Intl.DateTimeFormat('id-ID', { timeZone: options.settings?.timezone || 'Asia/Jakarta', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(clock());
      };
      updateClock(); const interval = setInterval(updateClock, 1000); cleanups.push(() => clearInterval(interval));
    } else if (widget.type === 'prayer') {
      Object.assign(box.style, { display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0.25em 0.4em' });
      const location = document.createElement('div'); location.style.fontSize = '0.52em';
      location.textContent = `Waktu Sholat · ${options.settings?.locationName || 'Jakarta'}`;
      const grid = document.createElement('div');
      Object.assign(grid.style, { display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '0.4em', marginTop: '0.25em' });
      const source = document.createElement('div'); source.style.fontSize = '0.3em'; source.style.opacity = '0.7'; source.style.marginTop = '0.45em';
      box.append(location, grid, source);
      const refresh = () => {
        const prayer = getPrayerTimes(clock(), options.settings || {}); grid.replaceChildren(); source.textContent = prayer.label;
        for (const [key, label] of [['fajr','Subuh'], ['dhuhr','Zuhur'], ['asr','Asar'], ['maghrib','Magrib'], ['isha','Isya']]) {
          const item = document.createElement('div'), title = document.createElement('div'), value = document.createElement('div');
          title.textContent = label; title.style.fontSize = '0.45em'; value.textContent = prayer.times[key]; value.style.fontWeight = '600';
          item.append(title, value); grid.append(item);
        }
      };
      refresh(); const interval = setInterval(refresh, 60000); cleanups.push(() => clearInterval(interval));
    }
  }
  return {
    element: wrapper, stage,
    requestStopAfterVideos(callback) {
      if (destroyed) return;
      stopRequested = true; stoppedCallback = callback;
      for (const record of videos) {
        record.lastProgress = Date.now();
        if (record.element.ended || record.failed) record.done = true;
      }
      stopCheck ||= setInterval(checkStopped, 500); checkStopped();
    },
    destroy() {
      destroyed = true; stoppedCallback = null; clearInterval(stopCheck);
      for (const cleanup of cleanups) cleanup(); wrapper.remove();
    },
  };
}
