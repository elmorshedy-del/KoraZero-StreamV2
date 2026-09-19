const CHANNEL_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export function createChannelRegistry(entries = {}) {
  const channels = new Map();

  for (const [channelId, config] of Object.entries(entries)) {
    if (!CHANNEL_ID.test(channelId)) {
      throw new Error(`Invalid channel id: ${channelId}`);
    }
    const source = typeof config?.source === 'string' ? config.source.trim() : '';
    if (!source) {
      throw new Error(`Channel ${channelId} requires a non-empty source`);
    }
    const alwaysOn = config?.alwaysOn === true;
    channels.set(channelId, Object.freeze({ channelId, source, alwaysOn }));
  }

  return Object.freeze({
    has(channelId) {
      return channels.has(channelId);
    },
    get(channelId) {
      return channels.get(channelId) ?? null;
    },
    entries() {
      return [...channels.values()].map((entry) => ({ ...entry }));
    },
  });
}
