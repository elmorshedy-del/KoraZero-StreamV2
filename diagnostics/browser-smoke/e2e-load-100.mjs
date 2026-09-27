import https from 'node:https';

const BASE=process.env.KZ_BASE_URL || 'https://korazero.com';
const MATCH=process.env.KZ_MATCH_ID || 'espn-uefa.nations-401861073';
const USERS=Math.max(1,Number(process.env.VIEWERS||100));
const UA='Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Mobile/15E148 Safari/604.1';

function get(url){
  return new Promise(resolve=>{
    const started=Date.now();
    const req=https.request(url,{
      method:'GET',agent:false,
      headers:{'User-Agent':UA,'Accept':'*/*','Cache-Control':'no-cache','Pragma':'no-cache'}
    },res=>{
      let bytes=0; const chunks=[];
      res.on('data',d=>{bytes+=d.length;if(chunks.reduce((a,b)=>a+b.length,0)<2048)chunks.push(d)});
      res.on('end',()=>resolve({status:res.statusCode||0,ms:Date.now()-started,bytes,body:Buffer.concat(chunks).toString('utf8').slice(0,2048)}));
    });
    req.setTimeout(15000,()=>req.destroy(new Error('timeout')));
    req.on('error',e=>resolve({status:0,ms:Date.now()-started,bytes:0,error:e.message,body:''}));
    req.end();
  });
}

async function user(id){
  const started=Date.now();
  const out={id};
  const nonce='e2e-'+Date.now()+'-'+id;
  out.home=await get(BASE+'/?__load='+encodeURIComponent(nonce));
  if(out.home.status<200 || out.home.status>=500) return {...out,stage:'HOME_FAIL',ok:false,totalMs:Date.now()-started};
  out.watch=await get(BASE+'/watch.html?match='+encodeURIComponent(MATCH)+'&__load='+encodeURIComponent(nonce));
  if(out.watch.status<200 || out.watch.status>=500) return {...out,stage:'WATCH_FAIL',ok:false,totalMs:Date.now()-started};
  const [plan,catalog,today]=await Promise.all([
    get(BASE+'/api/stream-plan?match='+encodeURIComponent(MATCH)+'&__load='+encodeURIComponent(nonce)),
    get(BASE+'/api/iptv-lab/catalog?__load='+encodeURIComponent(nonce)),
    get(BASE+'/assets/data/today.json?__load='+encodeURIComponent(nonce))
  ]);
  out.plan=plan; out.catalog=catalog; out.today=today;
  let stage='PASS';
  if(plan.status!==200) stage='PLAN_FAIL';
  else if(catalog.status!==200) stage='CATALOG_FAIL';
  else if(today.status!==200 && today.status!==304) stage='TODAY_FAIL';
  return {...out,stage,ok:stage==='PASS',totalMs:Date.now()-started};
}

function statMap(results,key){
  const m={}; for(const r of results){const s=String(r[key]?.status ?? 'missing');m[s]=(m[s]||0)+1;} return m;
}
function latency(results,key){
  const a=results.map(r=>r[key]?.ms).filter(Number.isFinite).sort((x,y)=>x-y);
  const p=q=>a.length?a[Math.min(a.length-1,Math.floor((a.length-1)*q))]:null;
  return {p50:p(.5),p95:p(.95),max:a.at(-1)??null};
}

console.log('HTTP100_COLD_BEGIN '+JSON.stringify({base:BASE,match:MATCH,users:USERS,cacheBust:true}));
const results=await Promise.all(Array.from({length:USERS},(_,i)=>user(i+1)));
const stages={};let pass=0;
for(const r of results){stages[r.stage]=(stages[r.stage]||0)+1;if(r.ok)pass++;}
const summary={
  users:USERS,pass,fail:USERS-pass,passPct:+(100*pass/USERS).toFixed(1),stages,
  statuses:{
    home:statMap(results,'home'),watch:statMap(results,'watch'),plan:statMap(results,'plan'),
    catalog:statMap(results,'catalog'),today:statMap(results,'today')
  },
  latencyMs:{
    home:latency(results,'home'),watch:latency(results,'watch'),plan:latency(results,'plan'),
    catalog:latency(results,'catalog'),today:latency(results,'today')
  },
  failureSamples:results.filter(r=>!r.ok).slice(0,15).map(r=>({
    id:r.id,stage:r.stage,
    home:r.home?.status,watch:r.watch?.status,plan:r.plan?.status,catalog:r.catalog?.status,today:r.today?.status,
    errors:{home:r.home?.error,watch:r.watch?.error,plan:r.plan?.error,catalog:r.catalog?.error,today:r.today?.error}
  }))
};
console.log('HTTP100_COLD_RESULT '+JSON.stringify(summary));
