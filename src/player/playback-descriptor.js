function validDescriptor(value) {
  return value
    && typeof value.channelId === 'string'
    && value.channelId.length > 0
    && typeof value.manifestUrl === 'string'
    && value.manifestUrl.length > 0;
}

export async function fetchPlaybackDescriptor(channelId, { fetchFn = globalThis.fetch } = {}) {
  if (!channelId) throw new Error('channelId is required');
  const response = await fetchFn(`/api/playback/${encodeURIComponent(channelId)}`, {
    headers: { accept: 'application/json' },
  });
  if (!response?.ok) {
    let detail = null;
    try {
      const body = await response.json();
      detail = body?.detail || body?.error || null;
    } catch {}
    throw new Error(detail || `Playback descriptor request failed with HTTP ${response?.status ?? 'unknown'}`);
  }
  const descriptor = await response.json();
  if (!validDescriptor(descriptor)) throw new Error('Invalid playback descriptor');
  return Object.freeze({
    channelId: descriptor.channelId,
    manifestUrl: descriptor.manifestUrl,
    verified: descriptor.verified === true,
    diagnostics: descriptor.diagnostics ?? null,
  });
}
