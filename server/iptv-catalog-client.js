function trimBase(value) {
  return String(value || '').replace(/\/+$/, '');
}
function nonNegativeInt(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
export function createIptvCatalogClient({ baseUrl, fetchFn = globalThis.fetch, sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const base = trimBase(baseUrl);
  if (!base) throw new Error('IPTV catalog client requires baseUrl');
  async function request(path) {
    const response = await fetchFn(`${base}${path}`, { headers: { accept: 'application/json' } });
    if (!response?.ok) throw new Error(`IPTV relay ${path} failed with HTTP ${response?.status ?? 'unknown'}`);
    return response.json();
  }
  async function list() {
    const value = await request('/catalog');
    if (!value || !Array.isArray(value.channels) || !Array.isArray(value.categories)) throw new Error('Invalid IPTV catalog response');
    return value;
  }
  async function account() {
    const value = await request('/account');
    return {
      auth: nonNegativeInt(value?.auth, 0),
      status: String(value?.status || ''),
      activeConnections: nonNegativeInt(value?.activeConnections, 0),
      maxConnections: nonNegativeInt(value?.maxConnections, 0),
      allowedOutputFormats: Array.isArray(value?.allowedOutputFormats) ? [...value.allowedOutputFormats] : [],
    };
  }
  async function waitForFreeSlot({ timeoutMs = 15_000, pollMs = 500 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    do {
      last = await account();
      if (last.activeConnections === 0) return last;
      await sleepFn(pollMs);
    } while (Date.now() < deadline);
    throw new Error(`Provider slot still busy (${last?.activeConnections ?? 'unknown'}/${last?.maxConnections ?? 'unknown'})`);
  }
  return Object.freeze({ list, account, waitForFreeSlot });
}
