import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { resolveProgram } from '../shared/program.mjs';
import { normalizeYouTubeUrl } from '../shared/youtube.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '0.2.4';
const MAX_UPLOAD = 512 * 1024 * 1024;
const MAX_ARCHIVE = 128 * 1024 * 1024;
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const okId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,90}$/.test(value);
const finite = (n, fallback, min, max) => Number.isFinite(Number(n)) ? Math.min(max, Math.max(min, Number(n))) : fallback;
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };

function makeHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const actual = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function json(res, status, object, extra = {}) {
  const data = JSON.stringify(object);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(data);
}
async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = []; let size = 0;
  if (Number(req.headers['content-length']) > limit) fail(413, 'Berkas atau permintaan terlalu besar.');
  for await (const chunk of req) { size += chunk.length; if (size > limit) fail(413, 'Berkas atau permintaan terlalu besar.'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function readJson(req, limit) {
  if (!String(req.headers['content-type']).startsWith('application/json')) fail(415, 'Gunakan format JSON.');
  try { return JSON.parse((await readBody(req, limit)).toString('utf8')); }
  catch (e) { if (e instanceof HttpError) throw e; fail(400, 'JSON tidak valid.'); }
}
function textValue(value, label, max = 180, min = 1) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) fail(400, `${label} tidak valid.`);
  return value.trim();
}
function secureHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com; object-src 'none'; base-uri 'none'; form-action 'self'");
}
function mediaSignature(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return ['image/png', 'image'];
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ['image/jpeg', 'image'];
  if (bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') return ['image/webp', 'image'];
  if (['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6))) return ['image/gif', 'image'];
  if (bytes.toString('ascii',4,8) === 'ftyp') return ['video/mp4', 'video'];
  if (bytes.subarray(0,4).equals(Buffer.from([26,69,223,163]))) return ['video/webm', 'video'];
  return null;
}
function mediaIdsOf(layout) {
  return [...new Set((layout.widgets || []).flatMap(w => w.enabled === false ? [] : [w.mediaId, w.type === 'youtube' ? w.fallbackMediaId : null, ...(w.playlist || []).map(i => i.mediaId)]).filter(Boolean))];
}
function cleanLayout(input, state, existing) {
  const width = finite(input.width, 1920, 320, 7680), height = finite(input.height, 1080, 240, 7680);
  if (!Array.isArray(input.widgets || []) || (input.widgets || []).length > 100) fail(400, 'Maksimal 100 elemen pada layout.');
  const types = ['text','image','video','youtube','ticker','clock','prayer'];
  const widgets = (input.widgets || []).map((w, index) => {
    if (!w || !types.includes(w.type)) fail(400, 'Jenis elemen tidak dikenal.');
    const result = {
      id: okId(w.id) ? w.id : uuid(), type: w.type, name: String(w.name || w.type).slice(0,120), enabled: w.enabled !== false,
      x: finite(w.x, 0, 0, width - 1), y: finite(w.y, 0, 0, height - 1),
      width: finite(w.width, 400, 1, width), height: finite(w.height, 100, 1, height), z: finite(w.z, index, -100, 1000),
      text: String(w.text || '').slice(0,20000), fontSize: finite(w.fontSize, 40, 8, 400),
      color: String(w.color || '#ffffff').slice(0,60), background: String(w.background || 'transparent').slice(0,60),
      align: ['left','center','right'].includes(w.align) ? w.align : 'left', fontWeight: finite(w.fontWeight, 400, 100, 900),
      borderRadius: finite(w.borderRadius, 0, 0, 500), fit: ['contain','cover','fill'].includes(w.fit) ? w.fit : 'contain',
      muted: w.muted !== false, volume: finite(w.volume, 1, 0, 1), speed: finite(w.speed, 80, 10, 600)
    };
    if (w.mediaId) { if (!state.media.some(m=>m.id===w.mediaId)) fail(400,'Media elemen tidak ditemukan.'); result.mediaId = w.mediaId; }
    if (w.type === 'youtube') {
      const requested = typeof w.youtubeUrl === 'string' ? w.youtubeUrl.trim() : '';
      if (requested) {
        let normalized;
        try { normalized = normalizeYouTubeUrl(requested); }
        catch { fail(400, 'Link YouTube tidak valid. Gunakan link langsung watch, live, youtu.be, atau embed.'); }
        result.youtubeUrl = normalized.url;
        result.youtubeVideoId = normalized.videoId;
      } else if (result.enabled) fail(400, 'Isi link YouTube sebelum mengaktifkan elemen.');
      else { result.youtubeUrl = ''; result.youtubeVideoId = ''; }
      if (w.fallbackMediaId) {
        if (!state.media.some(m => m.id === w.fallbackMediaId && ['image', 'video'].includes(m.kind))) fail(400, 'Media cadangan YouTube tidak ditemukan.');
        result.fallbackMediaId = w.fallbackMediaId;
      }
    }
    if (w.playlist !== undefined) {
      if (!Array.isArray(w.playlist) || w.playlist.length>100) fail(400,'Playlist tidak valid.');
      result.playlist=w.playlist.map(i=>{
        if(!i||typeof i!=='object'||Array.isArray(i)||!okId(i.mediaId))fail(400,'Item playlist tidak valid.');
        const media=state.media.find(m=>m.id===i.mediaId);
        if(!media)fail(400,'Media playlist tidak ditemukan.');
        if((w.type==='video'&&media.kind!=='video')||(w.type==='image'&&media.kind!=='image'))fail(400,w.type==='video'?'Playlist video hanya menerima file video.':'Playlist gambar hanya menerima file gambar.');
        if(i.muted!==undefined&&typeof i.muted!=='boolean')fail(400,'Pilihan bisukan suara pada video harus aktif atau nonaktif.');
        return{mediaId:i.mediaId,duration:finite(i.duration,10,1,86400),...(w.type==='video'&&typeof i.muted==='boolean'?{muted:i.muted}:{})};
      });
      if(w.type==='video')delete result.mediaId;
    }
    result.width=Math.min(result.width,width-result.x); result.height=Math.min(result.height,height-result.y);
    return result;
  });
  if (widgets.filter(w => w.type === 'youtube' && w.enabled).length > 1) fail(400, 'Maksimal satu siaran YouTube aktif pada setiap layout.');
  return { id: existing?.id || uuid(), name: textValue(input.name,'Nama layout'), width, height, background: String(input.background || '#0b1739').slice(0,60), duration: finite(input.duration,30,1,86400), widgets, updatedAt: now() };
}
function cleanSettings(input, previous) {
  const result = clone(previous);
  if (input.timezone !== undefined) { try { new Intl.DateTimeFormat('en',{timeZone:input.timezone}); } catch { fail(400,'Zona waktu tidak valid.'); } result.timezone=input.timezone; }
  if (input.locationName !== undefined) result.locationName=textValue(input.locationName,'Nama lokasi',120);
  if (input.latitude !== undefined) { if(!Number.isFinite(Number(input.latitude))||Math.abs(Number(input.latitude))>89)fail(400,'Lintang harus antara -89 dan 89.');result.latitude=Number(input.latitude); }
  if (input.longitude !== undefined) { if(!Number.isFinite(Number(input.longitude))||Math.abs(Number(input.longitude))>180)fail(400,'Bujur harus antara -180 dan 180.');result.longitude=Number(input.longitude); }
  if (input.prayer) {
    result.prayer.method='Kemenag';
    for(const key of ['fajr','dhuhr','asr','maghrib','isha']) if(input.prayer.adjustments?.[key]!==undefined)result.prayer.adjustments[key]=finite(input.prayer.adjustments[key],0,-60,60);
    if (input.prayer.timetable !== undefined) {
      if (!Array.isArray(input.prayer.timetable)||input.prayer.timetable.length>3660)fail(400,'Tabel jadwal sholat tidak valid.');
      result.prayer.timetable=input.prayer.timetable.map(row=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(row.date))fail(400,'Tanggal jadwal sholat tidak valid.');const r={date:row.date};for(const k of ['fajr','dhuhr','asr','maghrib','isha']){if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(row[k]||''))fail(400,'Jam sholat harus HH:MM.');r[k]=row[k];}return r;});
    }
  }
  return result;
}

export async function createSignageServer(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.SIGNAGE_DATA_DIR || path.join(ROOT,'data'));
  await fsp.mkdir(path.join(dataDir,'media'),{recursive:true});
  await fsp.mkdir(path.join(dataDir,'screenshots'),{recursive:true});
  await fsp.mkdir(path.join(dataDir,'backups'),{recursive:true});
  const db=new DatabaseSync(path.join(dataDir,'signage.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS store (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)');
  const saved=db.prepare('SELECT value FROM store WHERE id=1').get();
  let state=saved?JSON.parse(saved.value):{schema:1,admin:null,media:[],layouts:[],publications:[],players:[],schedules:[],pairCodes:[],settings:{timezone:'Asia/Jakarta',locationName:'Jakarta',latitude:-6.1754,longitude:106.8272,prayer:{method:'Kemenag',adjustments:{fajr:0,dhuhr:0,asr:0,maghrib:0,isha:0},timetable:[]}}};
  const save=()=>db.prepare('INSERT INTO store(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(state));
  if(!saved){
    const logo=await fsp.readFile(path.join(ROOT,'branding','RJ-Digital-Signage-System-logo-approved-v1.png'));
    const m={id:'brand-rj-approved',name:'Logo resmi RJ',kind:'image',mime:'image/png',size:logo.length,sha256:digest(logo),url:'/api/media/brand-rj-approved/file',createdAt:now()};
    await fsp.writeFile(path.join(dataDir,'media',m.id),logo);state.media.push(m);
    state.layouts.push(cleanLayout({name:'Selamat Datang',background:'#0b1739',widgets:[
      {id:'welcome-title',type:'text',x:100,y:180,width:1170,height:140,text:'Selamat Datang',fontSize:96,fontWeight:700,color:'#ffffff'},
      {id:'welcome-subtitle',type:'text',x:105,y:350,width:1120,height:160,text:'RJ Digital Signage',fontSize:44,fontWeight:500,color:'#77d9cc'},
      {id:'welcome-logo',type:'image',x:1390,y:180,width:420,height:420,mediaId:m.id},
      {id:'welcome-clock',type:'clock',x:100,y:720,width:1100,height:170,fontSize:66,color:'#ffffff'},
      {id:'welcome-ticker',type:'ticker',enabled:false,x:0,y:990,width:1920,height:90,text:'Selamat datang di RJ Digital Signage',background:'#008f83',fontSize:38},
      {id:'welcome-prayer',type:'prayer',enabled:false,x:100,y:530,width:1170,height:160,fontSize:28},
      {id:'welcome-video',type:'video',enabled:false,x:100,y:120,width:1120,height:630}
    ]},state)); save();
  }
  let setupToken='';
  if(!state.admin){const tokenPath=path.join(dataDir,'setup-token');try{setupToken=(await fsp.readFile(tokenPath,'utf8')).trim();}catch{setupToken=crypto.randomBytes(24).toString('hex');await fsp.writeFile(tokenPath,setupToken,{mode:0o600});}}
  const sessions=new Map(),events=new Map(),limits=new Map();
  const prune=()=>{const time=Date.now();for(const[k,v]of sessions)if(v.expires<time)sessions.delete(k);for(const[k,v]of limits)if(v.until<time)limits.delete(k);};
  const timer=setInterval(prune,60_000);timer.unref();
  function limited(key,max=12,windowMs=60_000){const item=limits.get(key);if(item&&item.until>Date.now()){if(item.count>=max)fail(429,'Terlalu banyak percobaan. Tunggu sebentar.');item.count++;}else limits.set(key,{count:1,until:Date.now()+windowMs});}
  function userOf(req){const cookie=String(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('rj_session='))?.slice(11);const session=cookie&&sessions.get(digest(cookie));return session&&session.expires>Date.now()?session:null;}
  function admin(req){const s=userOf(req);if(!s)fail(401,'Silakan masuk terlebih dahulu.');return s;}
  function localSetup(req){return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)&&/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(req.headers.host||'');}
  function checkMutation(req){if(req.headers['x-rj-request']!=='1')fail(403,'Permintaan tidak diizinkan.');if(req.headers.origin){let origin;try{origin=new URL(req.headers.origin);}catch{fail(403,'Asal permintaan tidak diizinkan.');}const configured=process.env.PUBLIC_ORIGIN;if(configured?origin.origin!==configured:origin.host!==req.headers.host)fail(403,'Asal permintaan tidak diizinkan.');}}
  function setSession(req,res){const token=crypto.randomBytes(32).toString('base64url');sessions.set(digest(token),{username:state.admin.username,expires:Date.now()+12*3600_000});res.setHeader('Set-Cookie',`rj_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${req.socket.encrypted?'; Secure':''}`);}
  function playerOf(req){const header=String(req.headers.authorization||'');if(!header.startsWith('Bearer '))fail(401,'Akses player ditolak.');const h=digest(header.slice(7));const p=state.players.find(p=>!p.revoked&&p.tokenHash===h);if(!p)fail(401,'Akses player ditolak.');return p;}
  function notify(id,event='update'){for(const res of events.get(id)||[]){if(res.destroyed||res.writableEnded)continue;try{res.write(`event: ${event}\ndata: ${JSON.stringify({time:now()})}\n\n`);}catch{}}}
  function notifyAll(){for(const p of state.players)notify(p.id);}
  function manifestFor(p){
    const activeIds=new Set(state.publications.filter(pub=>!pub.withdrawnAt).map(pub=>pub.id));
    const schedules=state.schedules.filter(s=>s.enabled!==false&&s.playerIds.includes(p.id)&&activeIds.has(s.publicationId));
    const ids=new Set([p.defaultPublicationId,p.manualOverride?.publicationId,...schedules.map(s=>s.publicationId)].filter(Boolean));
    const programs=state.publications.filter(pub=>ids.has(pub.id)&&!pub.withdrawnAt);
    const mids=new Set(programs.flatMap(pub=>pub.mediaIds));
    const body={schema:1,settings:clone(state.settings),defaultPublicationId:activeIds.has(p.defaultPublicationId)?p.defaultPublicationId:null,manualOverride:activeIds.has(p.manualOverride?.publicationId)?p.manualOverride:null,programs:clone(programs),schedules:clone(schedules),assets:state.media.filter(m=>mids.has(m.id)).map(m=>({...m,url:`/api/player/media/${m.id}/file`}))};
    return {...body,generation:digest(JSON.stringify(body)),serverTime:now()};
  }
  function transferFor(p,manifest,active,online) {
    // A previous download's 100% is not confirmation of a newly published
    // program. Legacy agents already acknowledge the committed generation.
    const ready=p.downloadedGeneration===manifest.generation;
    const desiredPublicationId=active?.id||null;
    let phase;
    if(p.revoked)phase='revoked';
    else if(!online)phase='offline';
    else if(!ready) {
      if(p.status==='downloading')phase='downloading';
      else if(['error','cached'].includes(p.status)&&p.lastError)phase='error';
      else phase='pending';
    } else if(desiredPublicationId&&p.currentPublicationId===desiredPublicationId)phase='playing';
    else if(['waiting-video','waiting_for_video'].includes(p.status))phase='waiting-video';
    else if(!manifest.programs.length&&!desiredPublicationId&&!p.currentPublicationId)phase='standby';
    else phase='ready';
    const progress=phase==='downloading'?finite(p.progress,0,0,99):['playing','waiting-video','ready','standby'].includes(phase)?100:null;
    return {phase,progress,ready,expectedGeneration:manifest.generation,desiredPublicationId,targetPublicationId:desiredPublicationId,updatedAt:p.lastSeen||null};
  }
  function publicPlayer(p){const {tokenHash,...safe}=p;delete safe.revoked;const manifest=manifestFor(p),active=resolveProgram(manifest,new Date()),online=!p.revoked&&Date.now()-new Date(p.lastSeen||0).getTime()<70_000;return {...safe,online,revoked:!!p.revoked,desiredPublicationId:active?.id||null,transfer:transferFor(p,manifest,active,online),screenshotUrl:p.screenshotAt?`/api/players/${p.id}/screenshot?t=${encodeURIComponent(p.screenshotAt)}`:null};}
  function publish(layout){if(layout.widgets.some(w=>w.enabled!==false&&w.type==='video'&&Array.isArray(w.playlist)&&!w.playlist.length))fail(400,'Tambahkan minimal satu video ke playlist aktif sebelum menerbitkan layout.');const mediaIds=mediaIdsOf(layout);for(const id of mediaIds)if(!state.media.some(m=>m.id===id))fail(400,'Media layout tidak lengkap.');const publication={id:uuid(),layoutId:layout.id,revision:state.publications.filter(p=>p.layoutId===layout.id).reduce((n,p)=>Math.max(n,p.revision),0)+1,layout:clone(layout),createdAt:now(),mediaIds};state.publications.push(publication);return publication;}
  function assign(p,pub){if(p.defaultPublicationId&&p.defaultPublicationId!==pub.id){p.history=[...(p.history||[]),p.defaultPublicationId].slice(-20);}p.defaultPublicationId=pub.id;p.manualOverride={publicationId:pub.id,since:now()};}
  function unpublishImpact(layout) {
    const publications=state.publications.filter(pub=>pub.layoutId===layout.id);
    const ids=new Set(publications.map(pub=>pub.id));
    const schedules=state.schedules.filter(s=>ids.has(s.publicationId));
    const scheduledPlayers=new Set(schedules.filter(s=>s.enabled!==false).flatMap(s=>s.playerIds));
    const relatedPlayers=state.players.filter(p=>ids.has(p.defaultPublicationId)||ids.has(p.manualOverride?.publicationId)||(p.history||[]).some(id=>ids.has(id))||scheduledPlayers.has(p.id));
    // Only configuration participates in confirmation. Heartbeats cannot make
    // an otherwise unchanged confirmation expire while the dialog is open.
    const configuration={layoutId:layout.id,name:layout.name,publications:publications.map(pub=>({id:pub.id,withdrawnAt:pub.withdrawnAt||null})),
      players:relatedPlayers.map(p=>({id:p.id,name:p.name,defaultPublicationId:p.defaultPublicationId,manualOverride:p.manualOverride,history:p.history||[]})),schedules};
    return {layoutId:layout.id,name:layout.name,publicationCount:publications.filter(pub=>!pub.withdrawnAt).length,
      players:relatedPlayers.map(p=>({id:p.id,name:p.name,online:!p.revoked&&Date.now()-Date.parse(p.lastSeen||0)<70000,
        assigned:ids.has(p.defaultPublicationId)||ids.has(p.manualOverride?.publicationId),scheduled:scheduledPlayers.has(p.id),historyOnly:!ids.has(p.defaultPublicationId)&&!ids.has(p.manualOverride?.publicationId)&&!scheduledPlayers.has(p.id)})),
      schedules:schedules.map(s=>({id:s.id,name:s.name,enabled:s.enabled!==false})),impactToken:digest(JSON.stringify(configuration))};
  }
  function unpublishLayout(layout) {
    const publications=state.publications.filter(pub=>pub.layoutId===layout.id),ids=new Set(publications.map(pub=>pub.id));
    const affected=new Set(),withdrawnAt=now();
    for(const pub of publications)if(!pub.withdrawnAt)pub.withdrawnAt=withdrawnAt;
    for(const schedule of state.schedules.filter(s=>ids.has(s.publicationId))) {
      if(schedule.enabled!==false){schedule.enabled=false;schedule.updatedAt=withdrawnAt;}
      for(const id of schedule.playerIds)affected.add(id);
    }
    for(const player of state.players) {
      const assigned=ids.has(player.defaultPublicationId)||ids.has(player.manualOverride?.publicationId);
      const history=(player.history||[]).filter(id=>!ids.has(id));
      if(assigned||history.length!==(player.history||[]).length||ids.has(player.currentPublicationId))affected.add(player.id);
      if(ids.has(player.defaultPublicationId))player.defaultPublicationId=null;
      if(ids.has(player.manualOverride?.publicationId))player.manualOverride=null;
      player.history=history;
    }
    save();for(const id of affected)notify(id);
  }
  function cleanSchedule(body,old){
    let publicationId=body.publicationId;
    const pendingLayout=body.layoutId?state.layouts.find(l=>l.id===body.layoutId):null;
    if(body.layoutId&&!pendingLayout)fail(404,'Layout tidak ditemukan.');
    if(!pendingLayout&&!state.publications.some(p=>p.id===publicationId&&(!p.withdrawnAt||body.enabled===false)))fail(400,'Versi layout belum diterbitkan atau sudah dibatalkan. Pilih layout untuk menerbitkan kembali.');
    const start=new Date(body.startAt),end=new Date(body.endAt);
    if(!/(Z|[+-]\d\d:\d\d)$/.test(body.startAt||'')||!/(Z|[+-]\d\d:\d\d)$/.test(body.endAt||'')||!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||end<=start)fail(400,'Awal dan akhir jadwal harus valid dan mencantumkan zona waktu.');
    if(!Array.isArray(body.playerIds)||!body.playerIds.length||body.playerIds.some(id=>!state.players.some(p=>p.id===id&&!p.revoked)))fail(400,'Pilih player yang terdaftar.');
    const repeat=['once','daily','weekly'].includes(body.repeat)?body.repeat:'once';
    const days=Array.isArray(body.days)?[...new Set(body.days.map(Number))].filter(d=>Number.isInteger(d)&&d>=0&&d<=6):[];
    if(repeat!=='once'&&end-start>31*86400_000)fail(400,'Rentang satu jadwal berulang maksimal 31 hari.');
    if(repeat==='weekly'&&!days.length)fail(400,'Pilih hari untuk jadwal mingguan.');
    if(body.until&&!/^\d{4}-\d{2}-\d{2}$/.test(body.until))fail(400,'Batas tanggal jadwal tidak valid.');
    const name=textValue(body.name||'Jadwal tayangan','Nama jadwal');
    if(pendingLayout)publicationId=publish(pendingLayout).id;
    return{id:old?.id||uuid(),name,publicationId,playerIds:[...new Set(body.playerIds)],enabled:body.enabled!==false,startAt:start.toISOString(),endAt:end.toISOString(),repeat,days,priority:finite(body.priority,0,0,100),until:body.until||null,createdAt:old?.createdAt||now(),updatedAt:now()};
  }
  async function serveFile(req,res,file,mime,name){
    let stat;try{stat=await fsp.stat(file);}catch{fail(404,'Berkas tidak ditemukan.');}
    let start=0,end=stat.size-1,status=200;
    const headers={'Content-Type':mime,'Accept-Ranges':'bytes','Cache-Control':'private, no-cache'};
    if(name)headers['Content-Disposition']=`inline; filename*=UTF-8''${encodeURIComponent(name)}`;
    if(req.headers.range){const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);if(!match||(!match[1]&&!match[2])){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});res.end();return;}if(!match[1]){start=Math.max(0,stat.size-Number(match[2]));}else{start=Number(match[1]);if(match[2])end=Number(match[2]);}if(start>end||start>=stat.size||end>=stat.size){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});res.end();return;}status=206;headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;}
    headers['Content-Length']=Math.max(0,end-start+1);res.writeHead(status,headers);if(req.method==='HEAD'){res.end();return;}await pipeline(fs.createReadStream(file,{start,end}),res);
  }
  async function makeArchive(){const safe={schema:1,media:clone(state.media),layouts:clone(state.layouts),publications:clone(state.publications),schedules:clone(state.schedules),settings:clone(state.settings),players:state.players.map(p=>({id:p.id,name:p.name,defaultPublicationId:p.defaultPublicationId||null,manualOverride:p.manualOverride||null,history:p.history||[]}))};const files=[];let total=0;for(const m of state.media){total+=m.size;if(total>80*1024*1024)fail(413,'Backup melalui dashboard maksimal 80 MB media. Gunakan backup volume Docker untuk data lebih besar.');files.push({id:m.id,data:(await fsp.readFile(path.join(dataDir,'media',m.id))).toString('base64')});}return{schema:1,createdAt:now(),state:safe,files};}
  const server=http.createServer(async(req,res)=>{
    secureHeaders(res);
    try{
      const url=new URL(req.url,'http://localhost'),route=url.pathname,method=req.method;
      if(method==='OPTIONS')fail(403,'Permintaan lintas situs tidak diizinkan.');
      if(route==='/api/health'){json(res,200,{status:'ok',version:VERSION,time:now()});return;}
      if(route==='/api/auth/status'&&method==='GET'){json(res,200,{initialized:!!state.admin,authenticated:!!userOf(req),user:userOf(req)?{username:state.admin.username}:undefined,localSetupAllowed:localSetup(req)});return;}
      if(route.startsWith('/api/auth/')&&method==='POST'){
        checkMutation(req);limited(`auth:${req.socket.remoteAddress}`,15,5*60_000);const body=await readJson(req);
        if(route==='/api/auth/setup'){
          if(state.admin)fail(409,'Akun admin sudah dibuat.');
          if(!localSetup(req)&&(!body.setupToken||!setupToken||digest(String(body.setupToken))!==digest(setupToken)))fail(403,'Masukkan kode pengaturan awal dari server.');
          const username=textValue(body.username,'Nama admin',80,3),password=body.password;
          if(typeof password!=='string'||password.length<12||password.length>256)fail(400,'Kata sandi minimal 12 karakter.');
          state.admin={username,passwordHash:makeHash(password)};save();setupToken='';await fsp.rm(path.join(dataDir,'setup-token'),{force:true});setSession(req,res);json(res,201,{user:{username}});return;
        }
        if(route==='/api/auth/login'){if(!state.admin||body.username!==state.admin.username||!verifyPassword(body.password,state.admin.passwordHash))fail(401,'Nama pengguna atau kata sandi salah.');setSession(req,res);json(res,200,{user:{username:state.admin.username}});return;}
        if(route==='/api/auth/logout'){const token=String(req.headers.cookie||'').match(/(?:^|;\s*)rj_session=([^;]+)/)?.[1];if(token)sessions.delete(digest(token));res.setHeader('Set-Cookie','rj_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');json(res,200,{ok:true});return;}
      }
      if(route==='/api/player/pair'&&method==='POST'){
        limited(`pair:${req.socket.remoteAddress}`,12,10*60_000);if(req.headers.origin)checkMutation(req);
        const body=await readJson(req),codeHash=digest(String(body.code||'')),entry=state.pairCodes.find(p=>p.hash===codeHash&&p.expiresAt>Date.now());if(!entry)fail(401,'Kode pemasangan salah atau kedaluwarsa.');
        const token=crypto.randomBytes(32).toString('base64url'),p={id:uuid(),name:textValue(body.name||'Player Windows','Nama player',120),tokenHash:digest(token),pairedAt:now(),lastSeen:now(),defaultPublicationId:null,manualOverride:null,history:[],status:'paired',progress:0,currentPublicationId:null};
        state.pairCodes=state.pairCodes.filter(e=>e!==entry);state.players.push(p);save();json(res,201,{id:p.id,token});return;
      }
      if(route.startsWith('/api/player/')){
        const p=playerOf(req);
        if(method==='GET'&&route==='/api/player/manifest'){json(res,200,manifestFor(p));return;}
        if(method==='GET'&&route==='/api/player/events'){
          res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write(`event: hello\ndata: ${JSON.stringify({time:now()})}\n\n`);
          const set=events.get(p.id)||new Set();set.add(res);events.set(p.id,set);const heartbeat=setInterval(()=>{if(p.revoked){res.end();return;}res.write(': heartbeat\n\n');},20_000);req.on('close',()=>{clearInterval(heartbeat);set.delete(res);});return;
        }
        const match=route.match(/^\/api\/player\/media\/([\w-]+)\/file$/);
        if(match&&['GET','HEAD'].includes(method)){const m=state.media.find(m=>m.id===match[1]);const allowed=new Set(manifestFor(p).assets.map(m=>m.id));if(!m||!allowed.has(m.id))fail(404,'Media tidak tersedia untuk player ini.');await serveFile(req,res,path.join(dataDir,'media',m.id),m.mime,m.name);return;}
        if(method==='POST'&&route==='/api/player/heartbeat'){const body=await readJson(req);p.lastSeen=now();p.status=String(body.status||'online').slice(0,80);p.progress=finite(body.progress,0,0,100);p.currentPublicationId=typeof body.currentPublicationId==='string'?body.currentPublicationId.slice(0,100):null;p.downloadedGeneration=String(body.downloadedGeneration||'').slice(0,80);p.lastError=String(body.lastError||'').slice(0,500);p.screen=body.screen&&{width:finite(body.screen.width,0,0,16000),height:finite(body.screen.height,0,0,16000)};save();json(res,200,{ok:true,serverTime:now()});return;}
        if(method==='POST'&&route==='/api/player/screenshot'){const bytes=await readBody(req,10*1024*1024);if(mediaSignature(bytes)?.[0]!=='image/png')fail(415,'Cuplikan harus berupa PNG.');await fsp.writeFile(path.join(dataDir,'screenshots',p.id+'.png'),bytes);p.screenshotAt=now();save();json(res,200,{ok:true});return;}
        fail(404,'Endpoint player tidak ditemukan.');
      }
      if(route.startsWith('/api/')){
        admin(req);if(!['GET','HEAD'].includes(method))checkMutation(req);
        if(route==='/api/state'&&method==='GET'){const stat=await fsp.statfs(dataDir).catch(()=>null);json(res,200,{version:VERSION,serverTime:now(),media:state.media,layouts:state.layouts,publications:state.publications,players:state.players.map(publicPlayer),schedules:state.schedules,settings:state.settings,storage:{usedBytes:state.media.reduce((s,m)=>s+m.size,0),freeBytes:stat?stat.bavail*stat.bsize:null}});return;}
        if(route==='/api/media'&&method==='POST'){
          if(Number(req.headers['content-length'])>MAX_UPLOAD)fail(413,'Maksimal ukuran media 512 MB.');
          const id=uuid(),temp=path.join(dataDir,'media',id+'.part'),destination=path.join(dataDir,'media',id),hash=crypto.createHash('sha256');let size=0,sample=Buffer.alloc(0),moved=false,committed=false;
          const cancellation=new AbortController();
          const cancel=()=>{if(!res.writableEnded)cancellation.abort();};
          req.once('aborted',cancel);res.once('close',cancel);
          const stream=new Transform({transform(chunk,encoding,callback){size+=chunk.length;if(size>MAX_UPLOAD){callback(new HttpError(413,'Maksimal ukuran media 512 MB.'));return;}hash.update(chunk);if(sample.length<64)sample=Buffer.concat([sample,chunk.subarray(0,64-sample.length)]);callback(null,chunk);}});
          try{
            await pipeline(req,stream,fs.createWriteStream(temp,{flags:'wx'}),{signal:cancellation.signal});
            cancellation.signal.throwIfAborted();
            const signature=mediaSignature(sample);if(!signature)fail(415,'Format didukung: PNG, JPG, WebP, GIF, MP4, atau WebM.');
            let name;try{name=decodeURIComponent(String(req.headers['x-filename']||'Media'));}catch{fail(400,'Nama media tidak valid.');}
            name=path.basename(name.replaceAll('\\','/')).replace(/[\x00-\x1f]/g,'').slice(0,200)||'Media';
            const m={id,name,mime:signature[0],kind:signature[1],size,sha256:hash.digest('hex'),url:`/api/media/${id}/file`,createdAt:now()};
            await fsp.rename(temp,destination);moved=true;
            cancellation.signal.throwIfAborted();
            // Once the synchronous database commit succeeds, a late disconnect
            // must not remove media that is already visible in the library.
            state.media.push(m);
            try{save();}catch(error){state.media.splice(state.media.indexOf(m),1);throw error;}
            committed=true;json(res,201,m);return;
          }finally{
            req.off('aborted',cancel);res.off('close',cancel);
            await fsp.rm(temp,{force:true}).catch(()=>{});
            if(moved&&!committed)await fsp.rm(destination,{force:true}).catch(()=>{});
          }
        }
        let m=route.match(/^\/api\/media\/([\w-]+)(\/file)?$/);
        if(m){const item=state.media.find(i=>i.id===m[1]);if(!item)fail(404,'Media tidak ditemukan.');if(m[2]&&['GET','HEAD'].includes(method)){await serveFile(req,res,path.join(dataDir,'media',item.id),item.mime,item.name);return;}if(method==='DELETE'&&!m[2]){if(state.layouts.some(l=>l.widgets.some(w=>w.mediaId===item.id||w.fallbackMediaId===item.id||w.playlist?.some(i=>i.mediaId===item.id)))||state.publications.some(p=>p.mediaIds.includes(item.id)))fail(409,'Media masih digunakan oleh layout atau versi terbit.');state.media=state.media.filter(i=>i.id!==item.id);save();await fsp.rm(path.join(dataDir,'media',item.id),{force:true});json(res,200,{ok:true});return;}}
        if(route==='/api/layouts'&&method==='POST'){const l=cleanLayout(await readJson(req),state);state.layouts.push(l);save();json(res,201,l);return;}
        m=route.match(/^\/api\/layouts\/([\w-]+)(?:\/(duplicate|publish|preview|unpublish))?$/);
        if(m){const l=state.layouts.find(l=>l.id===m[1]);if(!l)fail(404,'Layout tidak ditemukan.');
          if(method==='PUT'&&!m[2]){const updated=cleanLayout(await readJson(req),state,l);state.layouts[state.layouts.indexOf(l)]=updated;save();json(res,200,updated);return;}
          if(method==='DELETE'&&!m[2]){if(state.publications.some(p=>p.layoutId===l.id&&!p.withdrawnAt))fail(409,'Batalkan terbit layout terlebih dahulu sebelum menghapusnya.');state.layouts=state.layouts.filter(i=>i.id!==l.id);save();json(res,200,{ok:true});return;}
          if(method==='GET'&&m[2]==='unpublish'){json(res,200,unpublishImpact(l));return;}
          if(method==='POST'&&m[2]==='unpublish'){
            const body=await readJson(req),impact=unpublishImpact(l);
            if(body.confirm!=='BATALKAN TERBIT')fail(400,'Konfirmasikan pembatalan terbit layout.');
            if(body.impactToken!==impact.impactToken)fail(409,'Penggunaan layout berubah. Periksa daftar terbaru lalu konfirmasikan kembali.');
            unpublishLayout(l);json(res,200,{ok:true,layoutId:l.id});return;
          }
          if(method==='POST'&&m[2]==='duplicate'){const copied={...clone(l),id:uuid(),name:(l.name+' — Salinan').slice(0,180),updatedAt:now()};state.layouts.push(copied);save();json(res,201,copied);return;}
          if(method==='POST'&&m[2]==='publish'){const body=await readJson(req);if(!Array.isArray(body.playerIds)||body.playerIds.some(id=>!state.players.some(p=>p.id===id&&!p.revoked)))fail(400,'Pilih player yang terdaftar.');const pub=publish(l);for(const p of state.players.filter(p=>body.playerIds.includes(p.id)))assign(p,pub);save();for(const id of body.playerIds)notify(id);json(res,201,{publication:pub});return;}
          if(method==='GET'&&m[2]==='preview'){const ids=mediaIdsOf(l);json(res,200,{schema:1,generation:digest(JSON.stringify(l)),serverTime:now(),settings:state.settings,defaultPublicationId:'preview',manualOverride:null,programs:[{id:'preview',layoutId:l.id,revision:0,layout:l,mediaIds:ids}],schedules:[],assets:state.media.filter(m=>ids.includes(m.id))});return;}
        }
        if(route==='/api/preview/manifest'&&method==='GET'){const l=state.layouts.find(l=>l.id===url.searchParams.get('id'));if(!l)fail(404,'Layout tidak ditemukan.');const ids=mediaIdsOf(l);json(res,200,{schema:1,generation:digest(JSON.stringify(l)),serverTime:now(),settings:state.settings,defaultPublicationId:'preview',manualOverride:null,programs:[{id:'preview',layoutId:l.id,revision:0,layout:l,mediaIds:ids}],schedules:[],assets:state.media.filter(m=>ids.includes(m.id))});return;}
        if(route==='/api/players/pair-code'&&method==='POST'){limited('pair-code',20,60_000);const code=String(crypto.randomInt(100000,1000000)),expiresAt=Date.now()+10*60_000;state.pairCodes=state.pairCodes.filter(p=>p.expiresAt>Date.now());state.pairCodes.push({hash:digest(code),expiresAt});save();json(res,201,{code,expiresAt:new Date(expiresAt).toISOString()});return;}
        m=route.match(/^\/api\/players\/([\w-]+)(?:\/(action|screenshot))?$/);
        if(m){const p=state.players.find(p=>p.id===m[1]);if(!p)fail(404,'Player tidak ditemukan.');
          if(method==='GET'&&m[2]==='screenshot'){await serveFile(req,res,path.join(dataDir,'screenshots',p.id+'.png'),'image/png');return;}
          if(method==='POST'&&m[2]==='action'){const body=await readJson(req);if(body.action==='screenshot')notify(p.id,'screenshot');else if(body.action==='sync')notify(p.id);else if(body.action==='clear-override'){p.manualOverride=null;}else if(body.action==='rollback'){const history=(p.history||[]).filter(id=>state.publications.some(pub=>pub.id===id&&!pub.withdrawnAt)),prev=history.pop(),pub=state.publications.find(pub=>pub.id===prev);if(!pub)fail(409,'Belum ada versi sebelumnya untuk player ini.');p.history=history;p.defaultPublicationId=pub.id;p.manualOverride={publicationId:pub.id,since:now()};}else if(body.action==='revoke'){p.revoked=true;for(const r of events.get(p.id)||[])r.end();}else fail(400,'Tindakan player tidak dikenal.');save();notify(p.id);json(res,200,{ok:true,player:publicPlayer(p)});return;}
          if(method==='DELETE'&&!m[2]){if(state.schedules.some(s=>s.playerIds.includes(p.id)))fail(409,'Player masih digunakan dalam jadwal.');for(const r of events.get(p.id)||[])r.end();state.players=state.players.filter(i=>i.id!==p.id);save();json(res,200,{ok:true});return;}
        }
        if(route==='/api/schedules'&&method==='POST'){const s=cleanSchedule(await readJson(req));state.schedules.push(s);save();notifyAll();json(res,201,s);return;}
        m=route.match(/^\/api\/schedules\/([\w-]+)$/);
        if(m){const s=state.schedules.find(s=>s.id===m[1]);if(!s)fail(404,'Jadwal tidak ditemukan.');if(method==='PUT'){const updated=cleanSchedule(await readJson(req),s);state.schedules[state.schedules.indexOf(s)]=updated;save();notifyAll();json(res,200,updated);return;}if(method==='DELETE'){state.schedules=state.schedules.filter(i=>i.id!==s.id);save();notifyAll();json(res,200,{ok:true});return;}}
        if(route==='/api/settings'&&method==='PUT'){state.settings=cleanSettings(await readJson(req),state.settings);save();notifyAll();json(res,200,state.settings);return;}
        if(route==='/api/backup'&&method==='GET'){json(res,200,await makeArchive(),{'Content-Disposition':`attachment; filename="RJ-signage-backup-${now().slice(0,10)}.json"`});return;}
        if(route==='/api/restore'&&method==='POST'){
          const archive=await readJson(req,MAX_ARCHIVE);if(archive.confirm!=='PULIHKAN'||archive.schema!==1||!archive.state||!Array.isArray(archive.files))fail(400,'Backup atau konfirmasi pemulihan tidak valid.');
          const incoming=archive.state;if(!Array.isArray(incoming.media)||!Array.isArray(incoming.layouts)||!Array.isArray(incoming.publications)||!Array.isArray(incoming.schedules)||!Array.isArray(incoming.players))fail(400,'Struktur backup tidak valid.');
          if(incoming.media.length>5000||incoming.layouts.length>2000||incoming.publications.length>5000||incoming.schedules.length>5000)fail(400,'Backup melebihi batas jumlah data.');
          for(const collection of [incoming.media,incoming.layouts,incoming.publications,incoming.schedules,incoming.players]){const ids=new Set();for(const item of collection){if(!item||typeof item!=='object'||!okId(item.id)||ids.has(item.id))fail(400,'ID backup tidak valid atau duplikat.');ids.add(item.id);}}
          const settings=cleanSettings(incoming.settings||{},state.settings),buffers=new Map();let bytes=0;
          for(const file of archive.files){if(!okId(file.id)||typeof file.data!=='string'||buffers.has(file.id))fail(400,'Berkas backup tidak valid.');const b=Buffer.from(file.data,'base64');bytes+=b.length;if(bytes>80*1024*1024)fail(413,'Backup media maksimal 80 MB.');buffers.set(file.id,b);}
          const media=incoming.media.map(m=>{const b=buffers.get(m.id);if(!okId(m.id)||!b||b.length!==m.size||digest(b)!==m.sha256||mediaSignature(b)?.[0]!==m.mime)fail(400,'Integritas media backup tidak sesuai.');const existing=state.media.find(i=>i.id===m.id);if(existing&&existing.sha256!==m.sha256)fail(400,'ID media backup bertabrakan dengan berkas berbeda.');return{id:m.id,name:textValue(m.name,'Nama media',200),kind:mediaSignature(b)[1],mime:m.mime,size:b.length,sha256:digest(b),url:`/api/media/${m.id}/file`,createdAt:m.createdAt||now()};});
          const sandbox={...state,media},layouts=incoming.layouts.map(l=>{if(!okId(l.id))fail(400,'ID layout backup tidak valid.');return cleanLayout(l,sandbox,{id:l.id});});
          const publications=incoming.publications.map(p=>{if(!okId(p.id)||!okId(p.layoutId)||!p.layout||typeof p.layout!=='object')fail(400,'Versi backup tidak valid.');if(p.withdrawnAt!=null&&(typeof p.withdrawnAt!=='string'||!Number.isFinite(Date.parse(p.withdrawnAt))))fail(400,'Waktu pembatalan terbit dalam backup tidak valid.');const l=cleanLayout(p.layout,sandbox,{id:p.layoutId});return{id:p.id,layoutId:p.layoutId,revision:finite(p.revision,1,1,1000000),layout:l,createdAt:p.createdAt||now(),mediaIds:mediaIdsOf(l),...(p.withdrawnAt?{withdrawnAt:new Date(p.withdrawnAt).toISOString()}:{})};});
          const pids=new Set(publications.map(p=>p.id)),activePids=new Set(publications.filter(p=>!p.withdrawnAt).map(p=>p.id)),knownPlayers=new Set(state.players.map(p=>p.id));
          const playerConfigs=new Map(incoming.players.map(p=>{
            if(p.history!==undefined&&(!Array.isArray(p.history)||p.history.some(id=>!okId(id))))fail(400,'Riwayat player dalam backup tidak valid.');
            if(p.defaultPublicationId!=null&&(!okId(p.defaultPublicationId)||!activePids.has(p.defaultPublicationId)))fail(400,'Tayangan default player dalam backup tidak valid.');
            let manualOverride=null;
            if(p.manualOverride!=null){if(typeof p.manualOverride!=='object'||!activePids.has(p.manualOverride.publicationId)||!Number.isFinite(Date.parse(p.manualOverride.since)))fail(400,'Pengaturan tayangan manual dalam backup tidak valid.');manualOverride={publicationId:p.manualOverride.publicationId,since:new Date(p.manualOverride.since).toISOString()};}
            return[p.id,{defaultPublicationId:p.defaultPublicationId||null,manualOverride,history:(p.history||[]).filter(id=>activePids.has(id)).slice(-20)}];
          }));
          for(const s of incoming.schedules){if(!Array.isArray(s.playerIds)||s.playerIds.some(id=>!okId(id))||(s.days!==undefined&&!Array.isArray(s.days)))fail(400,'Daftar player atau hari jadwal backup tidak valid.');}
          const schedules=incoming.schedules.filter(s=>s.playerIds?.some(id=>knownPlayers.has(id))).map(s=>{if(!okId(s.id)||!pids.has(s.publicationId)||(s.enabled!==false&&!activePids.has(s.publicationId))||!Number.isFinite(Date.parse(s.startAt))||!Number.isFinite(Date.parse(s.endAt))||Date.parse(s.endAt)<=Date.parse(s.startAt))fail(400,'Jadwal backup tidak valid.');return{id:s.id,name:textValue(s.name,'Nama jadwal'),publicationId:s.publicationId,playerIds:s.playerIds.filter(id=>knownPlayers.has(id)),enabled:s.enabled!==false,startAt:s.startAt,endAt:s.endAt,repeat:['once','daily','weekly'].includes(s.repeat)?s.repeat:'once',days:(s.days||[]).filter(d=>Number.isInteger(d)&&d>=0&&d<=6),priority:finite(s.priority,0,0,100),until:s.until||null,updatedAt:now()};});
          const safety=await makeArchive();await fsp.writeFile(path.join(dataDir,'backups',`before-restore-${Date.now()}.json`),JSON.stringify(safety),{mode:0o600});
          for(const m of media){const file=path.join(dataDir,'media',m.id),temp=file+'.restore';await fsp.writeFile(temp,buffers.get(m.id));await fsp.rename(temp,file);}
          const restoredPlayers=state.players.map(p=>{const stored=playerConfigs.get(p.id);if(!stored)return{...p,defaultPublicationId:pids.has(p.defaultPublicationId)?p.defaultPublicationId:null,manualOverride:null,history:[]};return{...p,...stored};});
          state={...state,media,layouts,publications,schedules,settings,players:restoredPlayers};save();notifyAll();json(res,200,{ok:true,restored:{media:media.length,layouts:layouts.length,schedules:schedules.length},message:'Backup dipulihkan. Kredensial admin dan player yang terdaftar dipertahankan.'});return;
        }
        fail(404,'Endpoint tidak ditemukan.');
      }
      const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
      let file;
      if(route==='/brand/logo.png')file=path.join(ROOT,'branding','RJ-Digital-Signage-System-logo-approved-v1.png');
      else if(route.startsWith('/shared/')){const relative=route.slice(8);if(!/^[\w.-]+\.mjs$/.test(relative))fail(404,'Berkas tidak ditemukan.');file=path.join(ROOT,'shared',relative);}
      else {const relative=route==='/'?'index.html':route.slice(1);if(!/^[\w.-]+$/.test(relative))fail(404,'Halaman tidak ditemukan.');file=path.join(ROOT,'public',relative);}
      if(!['GET','HEAD'].includes(method))fail(405,'Metode tidak diizinkan.');await serveFile(req,res,file,mime[path.extname(file)]||'application/octet-stream');
    }catch(error){if(res.destroyed)return;if(res.headersSent){res.destroy();return;}const status=error.status||500;json(res,status,{error:status===500?'Terjadi gangguan pada server. Silakan coba kembali.':error.message});if(status===500)console.error('[RJ] Server error:',error.code||error.name);}
  });
  server.requestTimeout=20*60_000;server.headersTimeout=60_000;server.keepAliveTimeout=65_000;
  server.on('close',()=>{clearInterval(timer);for(const set of events.values())for(const r of set)r.end();db.close();});
  return {server,dataDir};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {server}=await createSignageServer();const host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT||3210);
  server.listen(port,host,()=>console.log(`RJ Digital Signage System ${VERSION} — http://${host}:${server.address().port}`));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.close();server.closeAllConnections();});
}
