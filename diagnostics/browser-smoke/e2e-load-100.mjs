import { webkit } from 'playwright';

const BASE = 'https://korazero.com';
const CHANNEL = '3645';
const iphoneUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Mobile/15E148 Safari/604.1';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function summarize(results) {
  const stageCounts = {};
  const statusCounts = {};
  let pass = 0;
  let hls200 = 0;
  let apiErrors = 0;
  const failureSamples = [];
  for (const r of results) {
    stageCounts[r.stage] = (stageCounts[r.stage] || 0) + 1;
    if (r.ok) pass++;
    if (r.hls200) hls200++;
    apiErrors += r.apiErrors || 0;
    for (const [k,v] of Object.entries(r.statuses || {})) {
      statusCounts[k] ||= {};
      statusCounts[k][String(v)] = (statusCounts[k][String(v)] || 0) + 1;
    }
    if (!r.ok && failureSamples.length < 12) failureSamples.push({
      id:r.id, stage:r.stage, error:r.error, statuses:r.statuses, apiErrors:r.apiErrors,
      hls200:r.hls200, lastUrl:r.lastUrl
    });
  }
  return {
    total: results.length,
    pass,
    fail: results.length - pass,
    passPct: +(100 * pass / results.length).toFixed(1),
    hls200,
    apiErrors,
    stageCounts,
    statusCounts,
    failureSamples
  };
}

const browser = await webkit.launch({ headless: true });

async function oneViewer(id) {
  const started = Date.now();
  const statuses = {};
  let apiErrors = 0;
  let hls200 = false;
  let lastUrl = null;
  let context;
  let page;

  try {
    context = await browser.newContext({
      viewport: { width: 430, height: 932 },
      userAgent: iphoneUA,
      isMobile: true,
      hasTouch: true,
    });
    page = await context.newPage();
    page.setDefaultTimeout(25000);

    page.on('response', (res) => {
      const u = res.url();
      const s = res.status();
      if (u.includes('/watch.html')) statuses.watch = s;
      if (u.includes('/api/stream-plan')) statuses.streamPlan = s;
      if (u.includes('/api/iptv-lab/catalog')) statuses.catalog = s;
      if (u.includes('/api/iptv-lab/channel')) statuses.channel = s;
      if (u.includes('/hls/') && (u.includes('.m3u8') || u.includes('.ts') || u.includes('.m4s'))) {
        if (s === 200) hls200 = true;
      }
      if ((u.includes('/api/stream-plan') || u.includes('/api/iptv-lab/catalog') || u.includes('/api/iptv-lab/channel')) && s >= 400) {
        apiErrors++;
      }
    });

    let resp;
    try {
      resp = await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 25000 });
      statuses.home = resp?.status() ?? null;
      lastUrl = page.url();
      if (!resp || resp.status() >= 500) {
        return { id, ok:false, stage:'HOME_FAIL', error:'home ' + (resp?.status() ?? 'no-response'), statuses, apiErrors, hls200, lastUrl, ms:Date.now()-started };
      }
    } catch (e) {
      return { id, ok:false, stage:'HOME_FAIL', error:e.message, statuses, apiErrors, hls200, lastUrl:page.url(), ms:Date.now()-started };
    }

    try {
      resp = await page.goto(BASE + '/watch.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
      statuses.watch = resp?.status() ?? statuses.watch ?? null;
      lastUrl = page.url();
      if (!resp || resp.status() >= 500) {
        return { id, ok:false, stage:'WATCH_FAIL', error:'watch ' + (resp?.status() ?? 'no-response'), statuses, apiErrors, hls200, lastUrl, ms:Date.now()-started };
      }
    } catch (e) {
      return { id, ok:false, stage:'WATCH_FAIL', error:e.message, statuses, apiErrors, hls200, lastUrl:page.url(), ms:Date.now()-started };
    }

    try {
      await page.waitForFunction(() => document.querySelectorAll('.channel-row').length > 0, { timeout: 30000 });
    } catch (e) {
      return { id, ok:false, stage:'CATALOG_FAIL', error:e.message, statuses, apiErrors, hls200, lastUrl:page.url(), ms:Date.now()-started };
    }

    try {
      await page.locator('#catalog-search').fill(CHANNEL);
      const row = page.locator('.channel-row').filter({ hasText:'#' + CHANNEL }).first();
      await row.waitFor({ state:'visible', timeout:15000 });
      await row.click();
    } catch (e) {
      return { id, ok:false, stage:'SELECT_FAIL', error:e.message, statuses, apiErrors, hls200, lastUrl:page.url(), ms:Date.now()-started };
    }

    try {
      await page.waitForFunction((id) => {
        const v = document.querySelector('#live-video');
        const channel = document.querySelector('#channel-id')?.textContent || '';
        return channel === 'iptv-' + id && v && !v.paused && v.readyState >= 2;
      }, CHANNEL, { timeout:60000 });

      const t1 = await page.locator('#live-video').evaluate(v => Number(v.currentTime || 0));
      await page.waitForTimeout(2500);
      const t2 = await page.locator('#live-video').evaluate(v => Number(v.currentTime || 0));
      if (!(t2 > t1 + 0.25)) throw new Error('video currentTime did not advance: ' + t1 + ' -> ' + t2);

      return { id, ok:true, stage:'PLAY_PASS', statuses, apiErrors, hls200, lastUrl:page.url(), ms:Date.now()-started, advanced:+(t2-t1).toFixed(2) };
    } catch (e) {
      return { id, ok:false, stage:'PLAY_FAIL', error:e.message, statuses, apiErrors, hls200, lastUrl:page.url(), ms:Date.now()-started };
    }
  } finally {
    await context?.close().catch(() => {});
  }
}

async function runWave(n, label, staggerMs) {
  console.log('E2E_WAVE_BEGIN ' + JSON.stringify({ label, n, base:BASE, channel:CHANNEL, staggerMs }));
  const tasks = Array.from({ length:n }, (_,i) => (async () => {
    await sleep(i * staggerMs);
    return oneViewer(i + 1);
  })());
  const results = await Promise.all(tasks);
  const summary = summarize(results);
  console.log('E2E_WAVE_RESULT ' + JSON.stringify({ label, ...summary }));
  return summary;
}

const sanity = await runWave(10, 'sanity-10', 50);
await sleep(3000);
const load100 = await runWave(100, 'load-100', 20);
console.log('E2E_FINAL ' + JSON.stringify({ sanity, load100 }));
await browser.close();
process.exit(0);
