# Kontrak implementasi 0.1

Semua berkas berada di folder proyek ini. JavaScript ESM, Node 24. Tanpa dependency runtime. Folder: server/, public/, shared/, player/, tests/, scripts/. Root mengerjakan backend, agent dashboard memiliki public/admin.* dan public/index.html; agent player memiliki shared/*, player/*, public/player.html, public/player.*. Jangan saling menimpa.

## API dashboard

Semua mutasi: header `X-RJ-Request: 1`, JSON kecuali upload. Sesi cookie HttpOnly SameSite Strict; fetch credentials same-origin. Error `{error: pesan}`.

- GET /api/auth/status -> `{initialized, authenticated, user?:{username}, localSetupAllowed}`.
- POST /api/auth/setup `{username,password,setupToken?}` -> `{user}`; minimal password 12 karakter.
- POST /api/auth/login `{username,password}` -> `{user}`; POST /api/auth/logout.
- GET /api/state -> `{version,serverTime,media:[],layouts:[],publications:[],players:[],schedules:[],settings,storage:{usedBytes,freeBytes}}`.
- POST /api/media: raw file body, Content-Type original, X-Filename=encodeURIComponent(name). -> media. GET /api/media/:id/file authenticated; range supported. DELETE /api/media/:id protected if referenced.
- CMS 0.2.4: upload cancellation aborts the current HTTP request; no additional cancellation endpoint. Incomplete uncommitted files are cleaned up and excluded from the library. If the server already committed a complete upload before the disconnect arrives, it remains valid media. The UI stops the rest of the selected batch and refreshes the library to reflect the authoritative result. Upload byte progress is capped at 99 until successful server acceptance.
- POST /api/layouts `{name,width?,height?,background?,widgets?}` -> layout. PUT /api/layouts/:id layout body -> layout. POST /api/layouts/:id/duplicate -> layout. DELETE /api/layouts/:id.
- POST /api/layouts/:id/publish `{playerIds:[]}` -> `{publication}` immutable snapshot; zero targets allowed to publish ready for schedule.
- GET /api/layouts/:id/unpublish -> `{layoutId,name,publicationCount,players:[{id,name,online,assigned,scheduled,historyOnly}],schedules:[{id,name,enabled}],impactToken}`. Admin session required. Token hashes relevant configuration only, excluding telemetry/heartbeat. POST same endpoint `{confirm:'BATALKAN TERBIT',impactToken}` -> `{ok:true,layoutId}`; missing confirmation 400, stale token 409 before mutation. Re-fetch impact and require a fresh confirmation on 409.
- POST /api/players/pair-code -> `{code,expiresAt}` six digit, one use, 10min.
- POST /api/players/:id/action `{action:'screenshot'|'sync'|'rollback'|'clear-override'|'revoke'}`. DELETE /api/players/:id.
- POST /api/schedules schedule object -> schedule; PUT /api/schedules/:id; DELETE /api/schedules/:id. Request `layoutId` creates published snapshot of current draft automatically. Endpoints return `{...schedule}`.
- PUT /api/settings -> validated settings. GET /api/backup returns JSON archive containing state and media base64, no credentials/tokens. POST /api/restore same archive JSON, requires `{...archive,confirm:'PULIHKAN'}`. Restore creates safety snapshot first and preserves auth/current player credentials; restore limits documented.

## Model

Media `{id,name,kind:'image'|'video',mime,size,sha256,url,createdAt}`.

Layout `{id,name,width,height,background,duration:30,widgets:[],updatedAt}`. Widget flat properties:
`{id,type:'text'|'image'|'video'|'ticker'|'clock'|'prayer',name?,enabled:true,x,y,width,height,z:0,text?,mediaId?,playlist?:[{mediaId,duration}],fontSize?:40,color?:'#ffffff',background?:'transparent',align?:'left'|'center'|'right',fontWeight?:400,borderRadius?:0,fit?:'contain'|'cover'|'fill',muted?:true,volume?:1,speed?:80}`. Coordinates pixels. All optional values default in renderer. Video loops until pending change, then completes current iteration; all active videos are allowed to finish, completed ones held, then swap. Stalled/broken videos must not prevent switch forever.

CMS 0.2.2 / Player 0.3.2: video playlist entries accept optional boolean `muted`. Each clip applies its explicit mute value before src/play; absent value inherits widget.muted for compatibility. Widget volume still applies to audible clips. Ordering and duplicates are preserved, max100 items; duration is retained for schema compatibility but file videos always finish their natural duration. A video playlist canonicalizes away widget.mediaId, accepts only video media, may be empty in a draft but cannot be actively published empty. Image playlists accept only images. Static editor video rendering creates a local placeholder and performs no video playback/media request.

Publication `{id,layoutId,revision:number,layout,createdAt,mediaIds:[]}`.

CMS 0.2.1 adds optional ISO `withdrawnAt` to publications. Unpublish marks all current snapshots of that layout withdrawn, clears related player default/manual/history configuration, disables related schedules, saves once, then notifies affected players. Actual currentPublicationId/status telemetry is retained until the player reports its new state. Withdrawn snapshots are absent from playback manifests, rollback and enabled schedules, and remain withdrawn through backup/restore. Republish creates a fresh immutable revision. A layout with only withdrawn snapshots can be deleted; snapshots, media and disabled schedule data remain retained, so media referenced by that history stays protected. Editing a schedule after its original draft is deleted requires choosing a replacement layout.

Player public `{id,name,lastSeen,online:boolean,currentPublicationId,desiredPublicationId,downloadedGeneration,progress,status,lastError,screenshotAt,screenshotUrl,defaultPublicationId,manualOverride,history:[]}`. No token hashes in public state.

CMS 0.2.3 adds derived `transfer:{phase,progress:number|null,ready:boolean,expectedGeneration,desiredPublicationId,targetPublicationId,updatedAt}` to each public player. The expected generation is computed from the current complete manifest, once per player. `ready` means exact equality with downloadedGeneration, a last-known cache acknowledgement; phase/progress prioritize offline/revoked. Phases are pending/downloading/error/ready/waiting-video/playing/standby/offline/revoked. Downloading reports are clamped to0..99; ready/playing/waiting/standby are100 only with matching generation; pending/error/offline/revoked have null progress. Existing raw telemetry stays unchanged. A playback warning is not automatically a transfer failure. These fields are not persisted, included in backup, or required in the player protocol. Legacy in-progress percentages are not generation-tagged, so only final completion is verified against the current generation.

Schedule `{id,name,publicationId,playerIds:[],enabled:true,startAt:ISO,endAt:ISO,repeat:'once'|'daily'|'weekly',days:[0..6],priority:0}`. startAt/endAt initial occurrence, repeat occurs in settings.timezone wall clock. Overnight supported; end exclusive; date expiry optional `until:YYYY-MM-DD`. Same priority tie stable newest id/order. UI warns about overlaps. ISO must include timezone offset.

Settings `{timezone:'Asia/Jakarta',locationName:'Jakarta',latitude:-6.1754,longitude:106.8272,prayer:{method:'Kemenag',adjustments:{fajr:0,dhuhr:0,asr:0,maghrib:0,isha:0},timetable:[]}}`. timetable optional exact local rows `{date:'YYYY-MM-DD',fajr:'HH:MM',dhuhr:'HH:MM',asr:'HH:MM',maghrib:'HH:MM',isha:'HH:MM'}`. Prefer timetable; otherwise local calculation with clear label, must not claim official verified times. No azan.

## Player server protocol

- POST /api/player/pair `{code,name}` -> `{id,token}`. Store private token only on device, protect local config. Other routes Authorization Bearer token.
- GET /api/player/manifest -> manifest below.
- GET /api/player/events -> SSE event `update`, `screenshot`, or `hello`, JSON data; heartbeat comment every 20s. On connection and reconnect fetch manifest; poll 60s fallback.
- GET /api/player/media/:id/file -> streamed/range file.
- POST /api/player/heartbeat `{status,progress,currentPublicationId,downloadedGeneration,lastError?,screen?}`.
- POST /api/player/screenshot raw image/png, max 10MiB.

Manifest `{schema:1,generation:string,serverTime,settings,defaultPublicationId,manualOverride:{publicationId,since}|null,programs:Publication[],schedules:Schedule[],assets:Media[]}`. Assets and programs include current/default and all enabled schedules for this player, bounded history. generation is hash of program configuration, not serverTime. Media downloads verified sha256+size; manifest becomes active only when complete. Server sends SSE update after publish/settings/schedule changes. Agent reports real download progress and does not overwrite last good manifest on failure.

Agent serves local GET /api/local/manifest, GET /api/local/status, GET /media/:id/file, POST /api/local/status (renderer playback ack). Local static /player.html + /player.js,/player.css and /shared/*.mjs. Local server bound 127.0.0.1, rejects remote origins. Root server also serves public/player.html for authenticated preview; GET /api/layouts/:id/preview -> manifest with single publication id 'preview', draft media URLs from /api/media/id/file. Root server /api/preview/manifest?id=layoutId alias supported. Renderer exported `mountRenderer(container,layout,{mediaUrl,settings,serverOffset?,onVideoBoundary?,onError?})`, returns `{requestStopAfterVideos(callback),destroy()}`. Preview /player.html?preview=layoutId. Embedded admin preview may use iframe. Shared `program.mjs` exports `resolveProgram(manifest, nowDate)` returning publication or null, and `getPrayerTimes(date,settings)` export from prayer.mjs. Shared renderer `shared/renderer.mjs` is used in admin preview and Windows playback.

Player 0.3.1 adds local status `playback:{renders,youtube:[{widgetId,state,reason,code,attempt,at,width,height}]}`. The agent validates known enum values and numeric bounds, drops other fields, accepts at most 8 records, and writes at most 40 state/attempt changes to `data/logs/playback-diagnostic.json`. It never writes raw renderer errors, URLs or credentials to this file. The additional diagnostic fields remain local; CMS heartbeat is unchanged. Sync and playback errors are tracked separately so successful synchronization does not hide an outstanding playback failure. `playbackKey(manifest,publication)` identifies only the selected publication/layout, settings and its referenced media, excluding generation/time/future inventory.

Manual publish sets defaultPublicationId and manualOverride.since=now, active schedules that started before manual publish are bypassed. New schedule occurrences after that time take precedence. Once schedules end fall back to default. Player uses this same offline resolver.

## Acceptance

YouTube extension (CMS 0.2.0 / Windows player 0.3.0): widget `{type:'youtube',youtubeUrl:canonicalWatchUrl,youtubeVideoId:derivedId,fallbackMediaId?:localMediaId,muted:true,volume:0..1,enabled:true}`. The server derives the ID, accepts direct watch/live/short/embed links only, and allows at most one enabled YouTube widget per layout. Enabled widgets require a valid URL; disabled drafts may omit it. Fallback media is included in `mediaIds` and manifest assets and is protected by normal reference checks.

Renderer options additionally accept `static`, `mediaKind(id)` and `onRecovery(widget)`. Static thumbnails/editor never load YouTube. Active embeds use the official IFrame API, a minimum actual 200×200 viewport and no covering widgets. Live is excluded from the file-video boundary wait. Errors/offline/buffering show cached local fallback; ended streams stay on fallback until republish. No YouTube audiovisual caching or arbitrary URL proxying. `shared/youtube.mjs` is required by both CMS renderer and local player static routes.

Player 0.3.1 uses 60-second startup/buffering grace and does not restart an existing embed on repeated online events. `onYouTubeState(state,widget,reason,details)` supplies only bounded diagnostic fields to the controller. Transient buffering keeps the same iframe; known errors or an expired grace period still activate fallback/retry.

Real HTTP test setup/login/auth, raw upload/range, immutable publish, pairing/auth isolation, SSE notification, schedules, rollback, media protection, backup/restore. Real agent cache sync and cold offline reload, video-boundary transition test in browser, editor UI and optional toggles. No real server deployment or Windows startup modification.
