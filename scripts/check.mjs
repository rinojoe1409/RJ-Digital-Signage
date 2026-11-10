import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const files=[];
async function scan(dir){for(const e of await readdir(path.join(root,dir),{withFileTypes:true})){const rel=path.join(dir,e.name);if(e.isDirectory())await scan(rel);else if(/\.(m?js)$/.test(e.name))files.push(rel);}}
for(const dir of ['server','public','shared','player','scripts','tests'])await scan(dir);
let errors=0;
for(const file of files){const run=spawnSync(process.execPath,['--check',path.join(root,file)],{encoding:'utf8',windowsHide:true});if(run.status!==0){console.error(file,run.stderr);errors++;}}
JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
if(errors)process.exitCode=1;else console.log(`Pemeriksaan sintaks lulus: ${files.length} berkas JavaScript.`);
