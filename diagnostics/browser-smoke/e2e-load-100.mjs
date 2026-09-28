import { webkit } from 'playwright';

const BASE = process.env.KZ_BASE_URL || 'https://korazero.com';
const MATCH = process.env.KZ_MATCH_ID || 'espn-caf.nations_qual-401920030';
const EXPECT = 'iptv-3645';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Mobile/15E148 Safari/604.1';

const browser = await webkit.launch({ headless:true });
const context = await browser.newContext({
  viewport:{width:430,height:932},
  userAgent:UA,
  isMobile:true,
  hasTouch:true,
});
const page = await context.newPage();
page.setDefaultTimeout(30000);

const obs = { statuses:{}, hls200:0, hlsErrors:0, segment200:0, plan:null, hlsUrls:[] };
page.on('response', async (res) => {
  const u=res.url(), s=res.status();
  if (u.includes('/watch.html')) obs.statuses.watch=s;
  if (u.includes('/api/stream-plan')) {
    obs.statuses.streamPlan=s;
    try { obs.plan=await res.json(); } catch {}
  }
  if (u.includes('/hls/')) {
    if (s===200) {
      obs.hls200++;
      if (/\.(?:ts|m4s)(?:\?|$)/i.test(u)) obs.segment200++;
    } else if (s>=400) obs.hlsErrors++;
    if (obs.hlsUrls.length<8) obs.hlsUrls.push({status:s,url:u});
  }
});

let result={ok:false,stage:'BOOT'};
try {
  const h=await page.goto(BASE+'/',{waitUntil:'domcontentloaded',timeout:25000});
  obs.statuses.home=h?.status() ?? null;
  if (!h || h.status()>=500) throw new Error('home failed '+(h?.status() ?? 'no-response'));

  const w=await page.goto(BASE+'/watch.html?match='+encodeURIComponent(MATCH),{waitUntil:'domcontentloaded',timeout:30000});
  obs.statuses.watch=w?.status() ?? obs.statuses.watch ?? null;
  if (!w || w.status()>=500) throw new Error('watch failed '+(w?.status() ?? 'no-response'));

  await page.waitForSelector('.kz-main-video',{state:'attached',timeout:60000});
  const selected = obs.plan?.selected?.playbackUrl || obs.plan?.selected?.url || '';
  if (!selected.includes('/hls/'+EXPECT+'/')) throw new Error('stream plan did not select '+EXPECT+': '+selected);

  await page.locator('.kz-main-video').evaluate(async v => {
    v.muted=true;
    try { await v.play(); } catch {}
  });

  await page.waitForFunction(() => {
    const v=document.querySelector('.kz-main-video');
    return v && v.readyState>=2 && !v.error;
  },{timeout:60000});

  const t1=await page.locator('.kz-main-video').evaluate(v=>Number(v.currentTime||0));
  await page.waitForTimeout(5000);
  const state=await page.locator('.kz-main-video').evaluate(v=>({
    currentTime:Number(v.currentTime||0),
    readyState:v.readyState,
    paused:v.paused,
    error:v.error?.code||null,
    currentSrc:v.currentSrc||v.src||''
  }));
  const advanced=state.currentTime-t1;
  if (!(advanced>1)) throw new Error('video did not advance: '+t1+' -> '+state.currentTime);
  if (obs.segment200<1) throw new Error('no successful HLS media segment observed');

  result={ok:true,stage:'PLAY_PASS',advanced:+advanced.toFixed(2),state};
} catch(e) {
  const shell=await page.locator('#player-shell').innerText().catch(()=>null);
  result={ok:false,stage:'FAIL',error:e.message,shell};
}
console.log('PUBLIC_CARD_PLAYBACK '+JSON.stringify({...result,...obs}));
await context.close();
await browser.close();
process.exit(result.ok?0:2);
