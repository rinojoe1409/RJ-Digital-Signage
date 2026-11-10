import { zonedParts } from './program.mjs';

const toRad = degree => degree * Math.PI / 180;
const toDeg = radian => radian * 180 / Math.PI;
const pad = number => String(number).padStart(2, '0');

/** Solar approximation for a local display; imported approved timetable takes precedence. */
export function getPrayerTimes(date = new Date(), settings = {}) {
  const timezone = settings.timezone || 'Asia/Jakarta';
  const local = zonedParts(date, timezone);
  const supplied = (settings.prayer?.timetable || []).find(row => row.date === local.date);
  const adjustments = settings.prayer?.adjustments || {};
  const keys = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
  const times = {};
  if (supplied) {
    for (const key of keys) {
      const raw = supplied[key];
      if (!/^\d{2}:\d{2}$/.test(raw || '')) { times[key] = '—'; continue; }
      const [hour, minute] = raw.split(':').map(Number);
      if (hour > 23 || minute > 59) { times[key] = '—'; continue; }
      const total = ((hour * 60 + minute + Math.round(Number(adjustments[key]) || 0)) % 1440 + 1440) % 1440;
      times[key] = `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
    }
    return { date: local.date, source: 'timetable', label: 'Jadwal tersimpan', times, ...times };
  }
  const latitude = Number(settings.latitude ?? -6.1754), longitude = Number(settings.longitude ?? 106.8272);
  const dayStamp = Date.UTC(local.year, local.month - 1, local.day);
  const dayNumber = Math.floor((dayStamp - Date.UTC(local.year, 0, 0)) / 86400000);
  const daysInYear = (Date.UTC(local.year + 1, 0, 1) - Date.UTC(local.year, 0, 1)) / 86400000;
  const gamma = 2 * Math.PI / daysInYear * (dayNumber - 1);
  const equation = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
  const declination = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  const solarNoon = 720 - 4 * longitude - equation;
  const angleMinutes = altitude => {
    const cosine = (Math.sin(toRad(altitude)) - Math.sin(toRad(latitude)) * Math.sin(declination))
      / (Math.cos(toRad(latitude)) * Math.cos(declination));
    return Math.abs(cosine) > 1 ? NaN : 4 * toDeg(Math.acos(cosine));
  };
  const asrAltitude = toDeg(Math.atan(1 / (1 + Math.tan(Math.abs(toRad(latitude) - declination)))));
  const minutes = {
    fajr: solarNoon - angleMinutes(-20), dhuhr: solarNoon + 2,
    asr: solarNoon + angleMinutes(asrAltitude), maghrib: solarNoon + angleMinutes(-0.833),
    isha: solarNoon + angleMinutes(-18),
  };
  for (const key of keys) {
    if (!Number.isFinite(minutes[key])) { times[key] = '—'; continue; }
    const instant = new Date(dayStamp + Math.ceil(minutes[key] + (Number(adjustments[key]) || 0)) * 60000);
    const part = zonedParts(instant, timezone);
    times[key] = `${pad(part.hour)}:${pad(part.minute)}`;
  }
  return { date: local.date, source: 'calculation', label: 'Perhitungan lokal · cocokkan jadwal setempat', times, ...times };
}
