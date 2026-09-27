import { webkit } from 'playwright';

const BASE = process.env.KZ_BASE_URL || 'https://korazero.com';
const MATCH = process.env.KZ_MATCH_ID || 'espn-uefa.nations-401861073';
const VIEWERS = Math.max(1, Number(process.env.VIEWERS || 100));
const CONTEXTS = Math.max(1, Math.min(VIEWERS, Number(process.env.CONTEXTS || 10)));
const SETTLE_MS = Math.max(1500, Number(process.env.SETTLE_MS || 4000));
const iphoneUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Mobile/15E148 Safari/604.1';

const browser = await webkit.launch({ headless:true });
const contexts=[];
for(let i=0;i<CONTEXTS;i++){
  const ctx=await browser.newContext({
    viewport:{width:430,height:932}, userAgent:iphoneUA, isMobile:true, hasTouch:true,
    extraHTTPHeaders:{'Cache-Control':'no-cache'}
  });
  await ctx.route('**/*', async route => {
    const req=route.request();
    const type=req.resourceType();
    const url=req.url();
    if (['image','font','media','stylesheet'].includes(type)) return route.abort();
    if (!url.startsWith(BASE) && /^https?:/i.test(url)) return route.abort();
    return route.continue();
  });
  contexts.push(ctx);
}

async function oneViewer(id){
  const started=Date.now();
  const ctx=contexts[(id-1)%CONTEXTS];
  let page;
  try { page=await ctx.newPage(); }
  catch(e){ return {id,ok:false,stage:'RUNNER_PAGE_FAIL',error:e.message,statuses:{},counts:{api5xx:0,other5xx:0},ms:Date.now()-started}; }
  page.setDefaultTimeout(20000);
  const statuses={};
  const counts={streamPlan:0,catalog:0,channel:0,api5xx:0,other5xx:0};
  try{
    page.on('response',res=>{
      const u=res.url(), s=res.status();
      if(u.includes('/api/stream-plan')){
        statuses.streamPlan=s; counts.streamPlan++;
        if(s>=500) counts.api5xx++;
      } else if(u.includes('/api/iptv-lab/catalog')){
        statuses.catalog=s; counts.catalog++;
        if(s>=500) counts.api5xx++;
      } else if(u.includes('/api/iptv-lab/channel')){
        statuses.channel=s; counts.channel++;
        if(s>=500) counts.api5xx++;
      } else if(s>=500 && u.startsWith(BASE)){
        counts.other5xx++;
      }
    });

    let home;
    try{
      home=await page.goto(BASE+'/',{waitUntil:'domcontentloaded',timeout:25000});
      statuses.home=home?.status() ?? null;
    }catch(e){
      return {id,ok:false,stage:'HOME_EXCEPTION',error:e.message,statuses,counts,ms:Date.now()-started};
    }
    if(!home || home.status()>=500){
      return {id,ok:false,stage:'HOME_FAIL',statuses,counts,ms:Date.now()-started};
    }

    let watch;
    try{
      watch=await page.goto(BASE+'/watch.html?match='+encodeURIComponent(MATCH),{waitUntil:'domcontentloaded',timeout:30000});
      statuses.watch=watch?.status() ?? null;
    }catch(e){
      return {id,ok:false,stage:'WATCH_EXCEPTION',error:e.message,statuses,counts,ms:Date.now()-started};
    }
    if(!watch || watch.status()>=500){
      return {id,ok:false,stage:'WATCH_FAIL',statuses,counts,ms:Date.now()-started};
    }

    await page.waitForTimeout(SETTLE_MS);

    let stage='FRONT_PASS', ok=true;
    if(statuses.streamPlan>=500){stage='PLAN_FAIL';ok=false;}
    else if(statuses.streamPlan!==200){stage='PLAN_MISSING';ok=false;}
    else if(statuses.catalog>=500){stage='CATALOG_FAIL';ok=false;}
    else if(statuses.catalog!=null && statuses.catalog!==200 && statuses.catalog!==304){stage='CATALOG_BAD_STATUS';ok=false;}

    return {id,ok,stage,statuses,counts,ms:Date.now()-started};
  } finally {
    await page.close().catch(()=>{});
  }
}

console.log('PUBLIC_100_BEGIN '+JSON.stringify({base:BASE,match:MATCH,viewers:VIEWERS,contexts:CONTEXTS,settleMs:SETTLE_MS}));
const results=await Promise.all(Array.from({length:VIEWERS},(_,i)=>oneViewer(i+1)));

const stageCounts={}, statusCounts={home:{},watch:{},streamPlan:{},catalog:{},channel:{}};
let pass=0,api5xx=0,other5xx=0;
const times=[];
for(const r of results){
  stageCounts[r.stage]=(stageCounts[r.stage]||0)+1;
  if(r.ok) pass++;
  api5xx+=r.counts?.api5xx||0;
  other5xx+=r.counts?.other5xx||0;
  times.push(r.ms);
  for(const k of Object.keys(statusCounts)){
    const v=r.statuses?.[k];
    if(v!=null) statusCounts[k][String(v)]=(statusCounts[k][String(v)]||0)+1;
  }
}
times.sort((a,b)=>a-b);
const pct=p=>times[Math.min(times.length-1,Math.floor((times.length-1)*p))]||null;
const failures=results.filter(r=>!r.ok).slice(0,20);
const summary={
  total:VIEWERS,contexts:CONTEXTS,pass,fail:VIEWERS-pass,passPct:+(100*pass/VIEWERS).toFixed(1),
  stageCounts,statusCounts,api5xx,other5xx,
  latencyMs:{p50:pct(.5),p95:pct(.95),max:times[times.length-1]||null},
  failures
};
console.log('PUBLIC_100_RESULT '+JSON.stringify(summary));
for(const ctx of contexts) await ctx.close().catch(()=>{});
await browser.close();
process.exit(0);
