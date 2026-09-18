import { createPlayerController } from './player-controller.js';
import { createBrowserHlsFactory } from './hls-adapter.js';
import { fetchPlaybackDescriptor } from './playback-descriptor.js';

const video = document.querySelector('#live-video');
const stateEl = document.querySelector('#player-state');
const messageEl = document.querySelector('#player-message');
const channelEl = document.querySelector('#channel-id');
const engineEl = document.querySelector('#player-engine');
const titleEl = document.querySelector('#channel-title');
const searchEl = document.querySelector('#catalog-search');
const categoryEl = document.querySelector('#catalog-category');
const listEl = document.querySelector('#catalog-list');
const countEl = document.querySelector('#catalog-count');
const moreEl = document.querySelector('#catalog-more');
const diagnosticEl = document.querySelector('#channel-diagnostic');

const PAGE_SIZE = 150;
let catalog = [];
let visibleLimit = PAGE_SIZE;
let selectedStreamId = null;
let activeChannel = null;
let selectionGeneration = 0;

const controller = createPlayerController({ video, hlsFactory: createBrowserHlsFactory() });

controller.subscribe((state) => {
  stateEl.textContent = state.status;
  channelEl.textContent = state.channelId ?? '—';
  engineEl.textContent = state.engine ?? '—';
  messageEl.textContent = state.error?.message ?? state.status;
});

function filteredChannels() {
  const query = (searchEl?.value || '').trim().toLocaleLowerCase();
  const categoryId = categoryEl?.value || '';
  return catalog.filter((channel) => {
    if (categoryId && channel.categoryId !== categoryId) return false;
    if (!query) return true;
    return `${channel.name} ${channel.categoryName} ${channel.streamId}`.toLocaleLowerCase().includes(query);
  });
}

function renderCatalog() {
  const filtered = filteredChannels();
  const shown = filtered.slice(0, visibleLimit);
  listEl.replaceChildren();
  for (const channel of shown) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'channel-row';
    if (channel.streamId === selectedStreamId) button.classList.add('is-active');
    const name = document.createElement('strong');
    name.textContent = channel.name;
    const meta = document.createElement('span');
    meta.textContent = `${channel.categoryName || 'Other'} · #${channel.streamId}`;
    button.append(name, meta);
    button.addEventListener('click', () => selectChannel(channel));
    listEl.append(button);
  }
  countEl.textContent = `${filtered.length.toLocaleString()} قناة`;
  moreEl.hidden = shown.length >= filtered.length;
}

async function selectChannel(channel, { updateUrl = true, userInitiated = true } = {}) {
  const myGeneration = ++selectionGeneration;
  selectedStreamId = channel.streamId;
  renderCatalog();
  titleEl.textContent = channel.name;
  messageEl.textContent = activeChannel ? 'جاري تبديل القناة…' : 'جاري تشغيل القناة…';
  if (diagnosticEl) diagnosticEl.textContent = 'VERIFYING…';

  // Keep the current picture alive while the next source is prepared.
  // This also runs synchronously from a real click to preserve the browser's
  // media user-activation when possible.
  if (userInitiated) controller.beginUserPlaybackIntent();

  try {
    const descriptor = await fetchPlaybackDescriptor(channel.streamId);
    if (myGeneration !== selectionGeneration) return;
    if (diagnosticEl) {
      const d = descriptor.diagnostics || {};
      const kb = Number.isFinite(Number(d.segmentBytes)) ? Math.round(Number(d.segmentBytes) / 1024) : null;
      const mode = d.transportMode || 'unknown';
      const ms = Number.isFinite(Number(d.verificationMs)) ? Math.round(Number(d.verificationMs)) : null;
      const attempt = d.attemptId ? ` · ${d.attemptId}` : '';
      diagnosticEl.textContent = descriptor.verified
        ? `VERIFIED · ${mode}${kb !== null ? ` · ${kb} KB` : ''}${ms !== null ? ` · ${ms} ms` : ''}${attempt}`
        : 'UNVERIFIED';
    }
    controller.load(descriptor, { autoplay: true });
    activeChannel = channel;
    selectedStreamId = channel.streamId;
    renderCatalog();
    if (updateUrl) {
      const url = new URL(location.href);
      url.searchParams.set('channel', channel.streamId);
      url.searchParams.set('title', channel.name);
      history.replaceState(null, '', url);
    }
  } catch (error) {
    if (myGeneration !== selectionGeneration) return;
    const errorMessage = error instanceof Error ? error.message : String(error);

    // A failed switch should not destroy the channel that was already playing.
    if (activeChannel) {
      selectedStreamId = activeChannel.streamId;
      titleEl.textContent = activeChannel.name;
      renderCatalog();
      messageEl.textContent = `تعذر التبديل: ${errorMessage}`;
    } else {
      messageEl.textContent = errorMessage;
    }

    if (diagnosticEl) {
      try {
        const response = await fetch(`/api/diagnostics/${encodeURIComponent(channel.streamId)}`, {
          headers: { accept: 'application/json' },
        });
        const diagnostic = response.ok ? await response.json() : null;
        diagnosticEl.textContent = diagnostic
          ? `FAILED · ${diagnostic.phase || 'unknown'} · ${diagnostic.error || errorMessage} · ${diagnostic.attemptId || ''}`
          : `FAILED · ${errorMessage}`;
      } catch {
        diagnosticEl.textContent = `FAILED · ${errorMessage}`;
      }
    }
  }
}

async function loadCatalog() {
  const response = await fetch('/api/catalog', { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Catalog request failed with HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload.channels) || !Array.isArray(payload.categories)) throw new Error('Invalid catalog response');
  catalog = payload.channels;
  for (const category of payload.categories) {
    const option = document.createElement('option');
    option.value = category.categoryId;
    option.textContent = `${category.name} (${category.count})`;
    categoryEl.append(option);
  }
  renderCatalog();
}

searchEl?.addEventListener('input', () => { visibleLimit = PAGE_SIZE; renderCatalog(); });
categoryEl?.addEventListener('change', () => { visibleLimit = PAGE_SIZE; renderCatalog(); });
moreEl?.addEventListener('click', () => { visibleLimit += PAGE_SIZE; renderCatalog(); });

const params = new URLSearchParams(location.search);
const initialChannelId = params.get('channel');
const initialTitle = params.get('title');

try {
  await loadCatalog();
  if (initialChannelId && /^\d+$/.test(initialChannelId)) {
    const channel = catalog.find((item) => item.streamId === initialChannelId);
    if (channel) await selectChannel(channel, { updateUrl: false, userInitiated: false });
    else messageEl.textContent = 'القناة غير موجودة في الكتالوج الحالي.';
  } else if (initialChannelId) {
    if (initialTitle) titleEl.textContent = initialTitle;
    controller.load(await fetchPlaybackDescriptor(initialChannelId), { autoplay: true });
  }
} catch (error) {
  countEl.textContent = 'تعذر تحميل الكتالوج';
  messageEl.textContent = error instanceof Error ? error.message : String(error);
}

window.addEventListener('pagehide', () => controller.destroy(), { once: true });
