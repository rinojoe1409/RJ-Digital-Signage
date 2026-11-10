import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSignageServer } from '../server/server.mjs';
import { createPlayer } from '../player/agent.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runtimeModules=process.env.RJ_RUNTIME_MODULES||path.join(root,'node_modules');
const require=createRequire(import.meta.url);
let chromium;
try{({chromium}=require('playwright'));}catch{({chromium}=require(path.join(runtimeModules,'playwright')));}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,timeout=15000){const start=Date.now();while(Date.now()-start<timeout){if(await check())return;await pause(80);}throw new Error('Kondisi player belum terpenuhi.');}

test('real server and Windows agent: verified delivery, actual video boundary, and offline browser cold start', {timeout:120000}, async t=>{
  await mkdir(path.join(root,'tmp'),{recursive:true});
  const directory=await mkdtemp(path.join(root,'tmp','playback-tests-'));
  const backend=await createSignageServer({dataDir:path.join(directory,'server')});
  await new Promise(resolve=>backend.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${backend.server.address().port}`;
  let backendOpen=true,player,browser,cookie='';
  t.after(async()=>{
    await browser?.close();await player?.close();
    if(backendOpen){backend.server.closeAllConnections();await new Promise(resolve=>backend.server.close(resolve));}
    assert.ok(directory.startsWith(path.join(root,'tmp','playback-tests-')));await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });
  const secret=randomBytes(24).toString('base64url');
  async function api(route,{method='GET',json,body,headers={}}={}){
    const response=await fetch(base+route,{method,headers:{...headers,...(cookie?{Cookie:cookie}:{}),...(method!=='GET'?{'X-RJ-Request':'1'}:{}),...(json?{'Content-Type':'application/json'}:{})},body:json?JSON.stringify(json):body});
    assert.ok(response.ok,`${method} ${route} HTTP${response.status}`);return response;
  }
  const setup=await api('/api/auth/setup',{method:'POST',json:{username:'uji-playback',password:secret}});cookie=setup.headers.get('set-cookie').split(';')[0];
  const code=await(await api('/api/players/pair-code',{method:'POST',json:{}})).json();
  const paired=await(await api('/api/player/pair',{method:'POST',json:{code:code.code,name:'Player Uji Playback'}})).json();
  player=await createPlayer({dataDir:path.join(directory,'player'),mediaDir:path.join(directory,'Content RJ Digital'),port:0,config:{serverUrl:base,id:paired.id,token:paired.token,name:'Uji'},headless:true});
  browser=await chromium.launch({...(process.env.RJ_BROWSER_EXECUTABLE ? { executablePath: process.env.RJ_BROWSER_EXECUTABLE } : {}),headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  const context=await browser.newContext({viewport:{width:1280,height:720}});
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/');
  const video64=await page.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;document.body.append(canvas);const ctx=canvas.getContext('2d');
    const stream=canvas.captureStream(15),recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'}),chunks=[];
    recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
    const complete=new Promise(resolve=>recorder.onstop=async()=>{stream.getTracks().forEach(track=>track.stop());canvas.remove();const bytes=new Uint8Array(await new Blob(chunks,{type:'video/webm'}).arrayBuffer());let text='';for(const b of bytes)text+=String.fromCharCode(b);resolve(btoa(text));});
    let frame=0;const paint=()=>{ctx.fillStyle='#0b1739';ctx.fillRect(0,0,640,360);ctx.fillStyle='#00a895';ctx.fillRect(frame++%500,140,120,80);ctx.fillStyle='#ffffff';ctx.font='32px sans-serif';ctx.fillText('Video uji RJ',60,80);};
    recorder.start(100);paint();stream.getVideoTracks()[0].requestFrame();const timer=setInterval(()=>{paint();stream.getVideoTracks()[0].requestFrame();},60);setTimeout(()=>{clearInterval(timer);recorder.stop();},2200);return complete;
  });
  const videoBytes=Buffer.from(video64,'base64');
  assert.ok(videoBytes.length>4,'MediaRecorder harus menghasilkan video uji nyata');
  assert.equal(videoBytes.subarray(0,4).toString('hex'),'1a45dfa3','Video uji memakai header WebM');
  const media=await(await api('/api/media',{method:'POST',body:videoBytes,headers:{'Content-Type':'video/webm','X-Filename':'video-uji.webm'}})).json();
  const layoutA=await(await api('/api/layouts',{method:'POST',json:{name:'Tayangan A',width:1280,height:720,background:'#0b1739',widgets:[{id:'video-main',type:'video',enabled:true,x:0,y:0,width:1280,height:720,mediaId:media.id,muted:true},{id:'ticker-off',type:'ticker',enabled:false,x:0,y:650,width:1280,height:70,text:'Tidak boleh tampil'},{id:'prayer-off',type:'prayer',enabled:false,x:0,y:450,width:1280,height:200}]}})).json();
  const pubA=(await(await api(`/api/layouts/${layoutA.id}/publish`,{method:'POST',json:{playerIds:[paired.id]}})).json()).publication;
  await until(()=>player.manifest?.defaultPublicationId===pubA.id);
  await page.goto(player.address+'/player.html');
  await page.locator('video').waitFor();
  await page.waitForFunction(()=>{const v=document.querySelector('video');return v&&v.currentTime>0.15&&!v.paused;});
  assert.equal(await page.locator('.rj-widget-ticker').count(),0);assert.equal(await page.locator('.rj-widget-prayer').count(),0);

  // Exercise the actual HTML video 'ended' boundary rather than a timer-only imitation.
  const boundary=await page.evaluate(async()=>{
    const module=await import('/shared/renderer.mjs'),host=document.createElement('div');Object.assign(host.style,{position:'fixed',width:'640px',height:'360px',left:'0',top:'0',zIndex:'100'});document.body.append(host);
    const layout={width:640,height:360,widgets:[{id:'boundary-video',type:'video',x:0,y:0,width:640,height:360,mediaId:document.querySelector('video').src.match(/\/media\/([^/]+)\//)[1],muted:true}]};
    const renderer=module.mountRenderer(host,layout,{mediaUrl:id=>`/media/${id}/file`});
    const video=host.querySelector('video');await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('video tidak berjalan')),8000);const check=()=>{if(video.currentTime>0.2&&!video.paused){clearTimeout(timer);resolve();}else setTimeout(check,30);};check();});
    let switched=false,ended=false;video.addEventListener('ended',()=>{ended=true;});const start=video.currentTime;
    const finished=new Promise(resolve=>renderer.requestStopAfterVideos(()=>{switched=true;resolve({start,current:video.currentTime,duration:video.duration,ended:video.ended||ended});}));
    await new Promise(resolve=>setTimeout(resolve,150));if(switched)throw new Error('Video terpotong sebelum selesai');
    const result=await finished;renderer.destroy();host.remove();return result;
  });
  assert.equal(boundary.ended,true);assert.ok(boundary.current>=boundary.duration-0.15);

  const layoutB=await(await api('/api/layouts',{method:'POST',json:{name:'Tayangan B',width:1280,height:720,widgets:[{id:'message-next',type:'text',enabled:true,x:60,y:60,width:1120,height:200,text:'Konten berikutnya',fontSize:70},{id:'ticker-on',type:'ticker',enabled:true,x:0,y:620,width:1280,height:100,text:'Informasi berjalan',fontSize:36},{id:'prayer-on',type:'prayer',enabled:true,x:50,y:300,width:1180,height:220,fontSize:58}]}})).json();
  const pubB=(await(await api(`/api/layouts/${layoutB.id}/publish`,{method:'POST',json:{playerIds:[paired.id]}})).json()).publication;
  await until(()=>player.manifest?.defaultPublicationId===pubB.id);
  await page.getByText('Konten berikutnya',{exact:true}).waitFor({timeout:12000});
  assert.equal(await page.locator('video').count(),0);assert.equal(await page.locator('.rj-widget-ticker').count(),1);assert.equal(await page.locator('.rj-widget-prayer').count(),1);
  await mkdir(path.join(root,'artifacts'),{recursive:true});await page.screenshot({path:path.join(root,'artifacts','player-local-1280.png')});
  await player.close();backend.server.closeAllConnections();await new Promise(resolve=>backend.server.close(resolve));backendOpen=false;
  player=await createPlayer({dataDir:path.join(directory,'player'),mediaDir:path.join(directory,'Content RJ Digital'),port:0,config:{serverUrl:base,id:paired.id,token:paired.token,name:'Uji'},headless:true,connect:false});
  await page.goto(player.address+'/player.html');await page.getByText('Konten berikutnya',{exact:true}).waitFor();
  assert.equal(player.manifest.defaultPublicationId,pubB.id);assert.equal(await page.locator('.rj-widget-prayer').count(),1);assert.deepEqual(errors,[]);
  await writeFile(path.join(root,'artifacts','playback-result.json'),JSON.stringify({videoBoundaryPassed:true,optionalElementsPassed:true,realServerAgentDeliveryPassed:true,offlineColdStartPassed:true,browserErrors:errors},null,2));
});
