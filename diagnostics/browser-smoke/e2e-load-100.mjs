import { webkit } from 'playwright';

const BASE = process.env.KZ_BASE_URL || 'https://korazero.com';
const MATCH = process.env.KZ_MATCH_ID || 'espn-caf.nations_qual-401920030';
const VIEWERS = Math.max(1, Number(process.env.VIEWERS || 1));
const STAGGER_MS = Math.max(0, Number(process.env.STAGGER_MS || 25));
const HOLD_MS = Math.max(2500, Number(process.env.HOLD_MS || 5000));
const iphoneUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Mobile/15E148 Safari/604.1';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// deploy marker: public e2e Norway-Portugal sanity

const browser = await webkit.launch({ headless: true });

async function oneViewer(id) {
  const started = Date.now();
  const statuses = {};
  let hls200 = 0, hlsErrors = 0, apiErrors = 0;
  let context, page;
  try {
    context = await browser.newContext({
      viewport:{width:430,height:932}, userAgent:iphoneUA, isMobile:true, hasTouch:true,
    });
    page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('response', (res) => {
      const u=res.url(), s=res.status();
      if (u.includes('/watch.html')) statuses.watch=s;
      if (u.includes('/api/stream-plan')) statuses.streamPlan=s;
      if (u.includes('/api/iptv-lab/catalog')) statuses.catalog=s;
      if (u.includes('/api/iptv-lab/channel')) statuses.channel=s;
      if (u.includes('/hls/') && (u.includes('.m3u8') || u.includes('.ts') || u.includes('.m4s'))) {
        if (s===200) hls200++; else if (s>=400) hlsErrors++;
      }
      if ((u.includes('/api/stream-plan') || u.includes('/api/iptv-lab/catalog') || u.includes('/api/iptv-lab/channel')) && s>=400) apiErrors++;
    });

    let home;
    try {
      home=await page.goto(BASE+'/', {waitUntil:'domcontentloaded', timeout:25000});
      statuses.home=home?.status() ?? null;
      if (!home || home.status()>=500) return {id,ok:false,stage:'HOME_FAIL',statuses,hls200,hlsErrors,apiErrors,ms:Date.now()-started};
    } catch(e) {
      return {id,ok:false,stage:'HOME_FAIL',error:e.message,statuses,hls200,hlsErrors,apiErrors,ms:Date.now()-started};
    }

    const url=BASE+'/watch.html?match='+encodeURIComponent(MATCH);
    let watch;
    try {
      watch=await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
      statuses.watch=watch?.status() ?? statuses.watch ?? null;
      if (!watch || watch.status()>=500) return {id,ok:false,stage:'WATCH_FAIL',statuses,hls200,hlsErrors,apiErrors,ms:Date.now()-started};
    } catch(e) {
      return {id,ok:false,stage:'WATCH_FAIL',error:e.message,statuses,hls200,hlsErrors,apiErrors,ms:Date.now()-started};
    }

    try {
      await page.waitForSelector('.kz-main-video',{state:'attached',timeout:45000});
    } catch(e) {
      const shell=await page.locator('#player-shell').innerText().catch(()=>null);
      return {id,ok:false,stage:'PLAYER_MOUNT_FAIL',error:e.message,statuses,hls200,hlsErrors,apiErrors,shell,ms:Date.now()-started};
    }

    try {
      await page.waitForFunction(() => {
        const v=document.querySelector('.kz-main-video');
        return !!v && v.readyState>=2 && !v.error;
      }, {timeout:45000});
      const t1=await page.locator('.kz-main-video').evaluate(v=>Number(v.currentTime||0));
      await page.waitForTimeout(HOLD_MS);
      const t2=await page.locator('.kz-main-video').evaluate(v=>Number(v.currentTime||0));
      const advanced=t2-t1;
      if (!(advanced>0.25)) throw new Error('video currentTime did not advance: '+t1+' -> '+t2);
      return {id,ok:true,stage:'PLAY_PASS',statuses,hls200,hlsErrors,apiErrors,advanced:+advanced.toFixed(2),ms:Date.now()-started};
    } catch(e) {
      const state=await page.locator('.kz-main-video').evaluate(v=>({readyState:v.readyState,paused:v.paused,error:v.error?.code||null,currentTime:Number(v.currentTime||0),src:v.currentSrc||v.src||null})).catch(()=>null);
      return {id,ok:false,stage:'PLAY_FAIL',error:e.message,statuses,hls200,hlsErrors,apiErrors,state,ms:Date.now()-started};
    }
  } finally {
    await context?.close().catch(()=>{});
  }
}

const tasks=Array.from({length:VIEWERS},(_,i)=>(async()=>{await sleep(i*STAGGER_MS);return oneViewer(i+1);})());
const results=await Promise.all(tasks);
const stageCounts={}, statusCounts={};
let pass=0,hls200Total=0,hlsErrors=0,apiErrors=0;
for(const r of results){
  stageCounts[r.stage]=(stageCounts[r.stage]||0)+1;
  if(r.ok) pass++;
  hls200Total+=r.hls200||0; hlsErrors+=r.hlsErrors||0; apiErrors+=r.apiErrors||0;
  for(const [k,v] of Object.entries(r.statuses||{})){
    statusCounts[k] ||= {};
    statusCounts[k][String(v)]=(statusCounts[k][String(v)]||0)+1;
  }
}
const failures=results.filter(r=>!r.ok).slice(0,12);
const summary={match:MATCH,total:VIEWERS,pass,fail:VIEWERS-pass,passPct:+(100*pass/VIEWERS).toFixed(1),stageCounts,statusCounts,hls200Total,hlsErrors,apiErrors,failures};
console.log('PUBLIC_E2E_RESULT '+JSON.stringify(summary));
await browser.close();
process.exit(pass===VIEWERS?0:2);
