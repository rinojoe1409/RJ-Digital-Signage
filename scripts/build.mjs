import { mkdir, cp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {version}=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('Versi paket tidak valid.');
const buildId=new Date().toISOString().replace(/\D/g,'').slice(0,14);
const target=path.join(root,'dist',`rj-signage-${version}-${buildId}`);
await mkdir(path.dirname(target),{recursive:true});await mkdir(target);
const packageFilter=source=>!path.relative(root,source).split(path.sep).some(part=>['data','node_modules','secrets','runtime','__pycache__','.venv'].includes(part)||part.startsWith('.test-')||part==='.env'||part.startsWith('.env.'))&&!/\.(?:log|pid|pyc|sqlite(?:-wal|-shm)?)$/.test(source);
for(const entry of ['server','shared','public','player','branding','scripts','tests','states','deploy','packaging','package.json','Dockerfile','compose.yaml','.dockerignore','.gitignore','eslint.config.mjs','Start-Local.cmd','README.md','PROJECT_MASTER.md','DESIGN_LOCK.md','PROJECT_SESSION_NOTES.md','PROJECT_VERSION.md','API_CONTRACT.md','RUNBOOK.md'])await cp(path.join(root,entry),path.join(target,entry),{recursive:true,filter:packageFilter});
const hashes=[];
async function collect(dir){for(const e of await readdir(path.join(target,dir),{withFileTypes:true})){const rel=path.join(dir,e.name);if(e.isDirectory())await collect(rel);else hashes.push({path:rel.replaceAll('\\','/'),sha256:crypto.createHash('sha256').update(await readFile(path.join(target,rel))).digest('hex')});}}
await collect('');await writeFile(path.join(target,'MANIFEST.json'),JSON.stringify({version,createdAt:new Date().toISOString(),files:hashes},null,2));
console.log(`Paket aplikasi dibuat: ${target}; ${hashes.length} berkas, tanpa data, token, kata sandi atau konfigurasi player.`);
