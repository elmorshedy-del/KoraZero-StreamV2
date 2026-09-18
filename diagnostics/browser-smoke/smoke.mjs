import { webkit } from 'playwright';

const BASE = process.env.KZ_BASE_URL || 'https://v2-control-production.up.railway.app';
const CHANNEL_A = process.env.KZ_CHANNEL_A || '3645';
const CHANNEL_B = process.env.KZ_CHANNEL_B || '3644';
const iphoneUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Mobile/15E148 Safari/604.1';

function log(label, value = {}) {
  console.log(label + ' ' + JSON.stringify(value));
}

const browser = await webkit.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 430, height: 932 },
  userAgent: iphoneUA,
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
const consoleErrors = [];

page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push('pageerror: ' + error.message));

async function snapshot() {
  return page.evaluate(() => {
    const video = document.querySelector('#live-video');
    return {
      state: document.querySelector('#player-state')?.textContent || null,
      channelId: document.querySelector('#channel-id')?.textContent || null,
      title: document.querySelector('#channel-title')?.textContent || null,
      diagnostic: document.querySelector('#channel-diagnostic')?.textContent || null,
      message: document.querySelector('#player-message')?.textContent || null,
      paused: video?.paused ?? null,
      muted: video?.muted ?? null,
      readyState: video?.readyState ?? null,
      currentTime: Number(video?.currentTime || 0),
      src: video?.currentSrc || video?.src || null,
    };
  });
}

async function clickAndVerify(streamId) {
  await page.locator('#catalog-search').fill(streamId);
  const row = page.locator('.channel-row').filter({ hasText: '#' + streamId }).first();
  await row.waitFor({ state: 'visible', timeout: 15000 });
  const name = (await row.locator('strong').textContent())?.trim() || null;
  const startedAt = Date.now();

  const beforeClick = await snapshot();
  await row.click();
  log('WEBKIT_CLICKED', { streamId, name });

  const transitionSamples = [];
  if (beforeClick.channelId && beforeClick.channelId !== '—') {
    const transitionDeadline = Date.now() + 15000;
    while (Date.now() < transitionDeadline) {
      const sample = await snapshot();
      transitionSamples.push({
        state: sample.state,
        channelId: sample.channelId,
        paused: sample.paused,
        currentTime: sample.currentTime,
      });
      if (sample.channelId === 'iptv-' + streamId) break;
      if (sample.state === 'STOPPED' || sample.state === 'IDLE' || sample.paused) {
        throw new Error('player stopped or paused during channel transition: ' + JSON.stringify(sample));
      }
      await page.waitForTimeout(250);
    }
  }

  await page.waitForFunction((id) => {
    const video = document.querySelector('#live-video');
    const diagnostic = document.querySelector('#channel-diagnostic')?.textContent || '';
    const channelId = document.querySelector('#channel-id')?.textContent || '';
    return diagnostic.includes('VERIFIED')
      && channelId === 'iptv-' + id
      && video
      && !video.paused
      && video.readyState >= 2;
  }, streamId, { timeout: 70000 });

  const first = await snapshot();
  await page.waitForTimeout(2500);
  const second = await snapshot();

  if (!(second.currentTime > first.currentTime + 0.25)) {
    throw new Error('currentTime did not advance for ' + streamId + ': ' + first.currentTime + ' -> ' + second.currentTime);
  }
  if (second.paused) throw new Error('video paused after automatic start for ' + streamId);

  const result = {
    streamId,
    name,
    clickToPlayingMs: Date.now() - startedAt - 2500,
    beforeClick,
    transitionSamples,
    first,
    second,
    advancedBy: second.currentTime - first.currentTime,
  };
  log('WEBKIT_CHANNEL_PASS', result);
  return result;
}

try {
  log('WEBKIT_SMOKE_START', { base: BASE, channelA: CHANNEL_A, channelB: CHANNEL_B });

  await page.goto(BASE + '/watch.html', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForFunction(
    () => document.querySelectorAll('.channel-row').length > 0,
    { timeout: 30000 },
  );
  log('WEBKIT_CATALOG_READY', { rows: await page.locator('.channel-row').count() });

  const first = await clickAndVerify(CHANNEL_A);
  const second = await clickAndVerify(CHANNEL_B);

  const result = {
    ok: true,
    browser: 'webkit-iphone',
    first,
    second,
    consoleErrors: consoleErrors.slice(-20),
  };
  log('WEBKIT_SWITCH_PASS', result);
  await browser.close();
  process.exit(0);
} catch (error) {
  const failedSnapshot = await snapshot().catch(() => null);
  log('WEBKIT_SWITCH_FAIL', {
    ok: false,
    error: error?.message || String(error),
    snapshot: failedSnapshot,
    consoleErrors: consoleErrors.slice(-20),
  });
  await browser.close().catch(() => {});
  process.exit(1);
}
