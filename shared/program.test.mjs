import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProgram, scheduleOccurrence, playbackKey } from './program.mjs';
import { getPrayerTimes } from './prayer.mjs';

test('active playback survives future inventory changes but changes with its own media or settings', () => {
  const publication = { id: 'live', mediaIds: ['fallback'], layout: { width: 1280, height: 720, widgets: [{ type: 'youtube', youtubeUrl: 'https://youtube.com/watch?v=rQJoEpzKkNk' }] } };
  const manifest = { generation: 'a', settings: { timezone: 'Asia/Jakarta' }, assets: [{ id: 'fallback', kind: 'image', sha256: 'a' }], programs: [publication] };
  const first = playbackKey(manifest, publication);
  const future = { ...manifest, generation: 'b', serverOffset: 750, syncedAt: new Date().toISOString(),
    programs: [...manifest.programs, { id: 'tomorrow' }], schedules: [{ id: 'future' }], assets: [...manifest.assets, { id: 'future-media', sha256: 'b' }] };
  assert.equal(playbackKey(future, publication), first);
  assert.notEqual(playbackKey({ ...manifest, assets: [{ ...manifest.assets[0], sha256: 'changed' }] }, publication), first);
  assert.notEqual(playbackKey({ ...manifest, settings: { timezone: 'Asia/Makassar' } }, publication), first);
  assert.notEqual(playbackKey(manifest, { ...publication, id: 'republished' }), first);
  assert.equal(playbackKey(future, null), playbackKey(manifest, null));
});

test('daily overnight recurrence uses local date, including the previous day', () => {
  const schedule = { id: 'night', enabled: true, repeat: 'daily', startAt: '2026-11-01T20:00:00+07:00', endAt: '2026-11-02T06:00:00+07:00' };
  const match = scheduleOccurrence(schedule, new Date('2026-11-04T02:00:00+07:00'), 'Asia/Jakarta');
  assert.equal(match.start.toISOString(), '2026-11-03T13:00:00.000Z');
  assert.equal(match.end.toISOString(), '2026-11-03T23:00:00.000Z');
  assert.equal(scheduleOccurrence(schedule, new Date('2026-11-04T06:00:00+07:00'), 'Asia/Jakarta'), null);
});

test('weekly days, expiration and manual override are respected offline', () => {
  const schedule = { id: 'weekly', publicationId: 'scheduled', repeat: 'weekly', days: [2], enabled: true, startAt: '2026-11-03T09:00:00+07:00', endAt: '2026-11-03T10:00:00+07:00', until: '2026-11-10' };
  assert.ok(scheduleOccurrence(schedule, new Date('2026-11-10T09:30:00+07:00')));
  assert.equal(scheduleOccurrence(schedule, new Date('2026-11-11T09:30:00+07:00')), null);
  assert.equal(scheduleOccurrence(schedule, new Date('2026-11-17T09:30:00+07:00')), null);
  const manifest = { settings: { timezone: 'Asia/Jakarta' }, programs: [{ id: 'scheduled' }, { id: 'manual' }], schedules: [schedule], defaultPublicationId: 'manual', manualOverride: { publicationId: 'manual', since: '2026-11-03T09:15:00+07:00' } };
  assert.equal(resolveProgram(manifest, new Date('2026-11-03T09:30:00+07:00')).id, 'manual');
  assert.equal(resolveProgram(manifest, new Date('2026-11-10T09:30:00+07:00')).id, 'scheduled');
});

test('schedule priority wins and expiry falls back to default', () => {
  const event = { startAt: '2026-11-03T09:00:00+07:00', endAt: '2026-11-03T11:00:00+07:00', repeat: 'once', enabled: true };
  const manifest = { programs: [{ id: 'normal' }, { id: 'special' }, { id: 'fallback' }], schedules: [
    { ...event, id: 'a', publicationId: 'normal', priority: 0 }, { ...event, id: 'b', publicationId: 'special', priority: 10 },
  ], defaultPublicationId: 'fallback' };
  assert.equal(resolveProgram(manifest, new Date('2026-11-03T10:00:00+07:00')).id, 'special');
  assert.equal(resolveProgram(manifest, new Date('2026-11-03T11:00:00+07:00')).id, 'fallback');
});

test('imported prayer timetable takes precedence and minute corrections wrap safely', () => {
  const result = getPrayerTimes(new Date('2026-11-03T10:00:00+07:00'), { timezone: 'Asia/Jakarta', prayer: {
    adjustments: { fajr: 3, isha: 5 }, timetable: [{ date: '2026-11-03', fajr: '04:11', dhuhr: '11:40', asr: '15:00', maghrib: '17:50', isha: '23:58' }],
  } });
  assert.equal(result.source, 'timetable'); assert.equal(result.fajr, '04:14'); assert.equal(result.isha, '00:03');
  const calculated = getPrayerTimes(new Date('2026-11-04T10:00:00+07:00'), { timezone: 'Asia/Jakarta' });
  assert.equal(calculated.source, 'calculation');
  for (const time of Object.values(calculated.times)) assert.match(time, /^\d{2}:\d{2}$/);
});
