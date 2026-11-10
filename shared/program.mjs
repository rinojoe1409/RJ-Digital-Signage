/** Offline schedule resolver. All recurrence dates follow the configured wall clock. */
export function zonedParts(date, timezone = 'Asia/Jakarta') {
  const fields = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  return { ...fields, date: `${fields.year}-${String(fields.month).padStart(2, '0')}-${String(fields.day).padStart(2, '0')}` };
}

function calendarStamp(parts) { return Date.UTC(parts.year, parts.month - 1, parts.day); }
function dayParts(stamp) {
  const date = new Date(stamp);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function wallTimeToDate(parts, timezone = 'Asia/Jakarta') {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0);
  let value = target;
  for (let n = 0; n < 4; n++) {
    const observed = zonedParts(new Date(value), timezone);
    const stamp = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second);
    const difference = target - stamp;
    value += difference;
    if (!difference) break;
  }
  return new Date(value);
}

export function scheduleOccurrence(schedule, now = new Date(), timezone = 'Asia/Jakarta') {
  if (!schedule || schedule.enabled === false) return null;
  const start = new Date(schedule.startAt), end = new Date(schedule.endAt);
  if (!Number.isFinite(+start) || !Number.isFinite(+end) || +end <= +start) return null;
  if (!schedule.repeat || schedule.repeat === 'once') {
    return +now >= +start && +now < +end ? { start, end, schedule } : null;
  }
  const localStart = zonedParts(start, timezone), localEnd = zonedParts(end, timezone);
  const current = zonedParts(now, timezone);
  const dayLength = 86400000;
  const startDay = calendarStamp(localStart);
  const durationDays = Math.max(0, Math.round((calendarStamp(localEnd) - startDay) / dayLength));
  const earliest = Math.min(31, durationDays + 1);
  for (let delta = 0; delta <= earliest; delta++) {
    const candidateDay = calendarStamp(current) - delta * dayLength;
    if (candidateDay < startDay) continue;
    const candidate = dayParts(candidateDay);
    const candidateKey = `${candidate.year}-${String(candidate.month).padStart(2, '0')}-${String(candidate.day).padStart(2, '0')}`;
    if (schedule.until && candidateKey > schedule.until) continue;
    if (schedule.repeat === 'weekly') {
      const days = Array.isArray(schedule.days) && schedule.days.length ? schedule.days : [new Date(startDay).getUTCDay()];
      if (!days.includes(new Date(candidateDay).getUTCDay())) continue;
    }
    const occurrenceStart = wallTimeToDate({ ...candidate, hour: localStart.hour, minute: localStart.minute, second: localStart.second }, timezone);
    const occurrenceEnd = wallTimeToDate({ ...dayParts(candidateDay + durationDays * dayLength), hour: localEnd.hour, minute: localEnd.minute, second: localEnd.second }, timezone);
    if (+occurrenceStart < +start) continue;
    if (+now >= +occurrenceStart && +now < +occurrenceEnd) return { start: occurrenceStart, end: occurrenceEnd, schedule };
  }
  return null;
}

export function resolveProgram(manifest, now = new Date()) {
  if (!manifest) return null;
  const programs = new Map((manifest.programs || []).map(p => [p.id, p]));
  const manual = manifest.manualOverride;
  const candidates = (manifest.schedules || []).map(s => scheduleOccurrence(s, now, manifest.settings?.timezone || 'Asia/Jakarta'))
    .filter(Boolean).filter(o => programs.has(o.schedule.publicationId))
    .filter(o => !manual?.since || +o.start > +new Date(manual.since));
  candidates.sort((a, b) => (Number(b.schedule.priority) || 0) - (Number(a.schedule.priority) || 0)
    || String(b.schedule.createdAt || '').localeCompare(String(a.schedule.createdAt || ''))
    || String(b.schedule.id).localeCompare(String(a.schedule.id)));
  if (candidates.length) return programs.get(candidates[0].schedule.publicationId);
  return programs.get(manual?.publicationId) || programs.get(manifest.defaultPublicationId) || null;
}

/** Only changes to what is on screen should restart its media, never future schedules or heartbeats. */
export function playbackKey(manifest, publication) {
  if (!publication) return 'standby';
  const mediaIds = new Set(publication.mediaIds || (publication.layout?.widgets || []).flatMap(widget =>
    [widget.mediaId, widget.fallbackMediaId, ...(widget.playlist || []).map(item => item.mediaId)].filter(Boolean)));
  const assets = (manifest.assets || []).filter(asset => mediaIds.has(asset.id))
    .map(asset => ({ id: asset.id, sha256: asset.sha256, kind: asset.kind })).sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({ id: publication.id, layout: publication.layout, settings: manifest.settings || {}, assets });
}
