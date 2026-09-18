function trimBase(value) {
  return String(value || '').replace(/\/+$/, '');
}

function nonNegativeInt(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function sleep(ms, signal, sleepFn) {
  throwIfAborted(signal);
  if (!signal) return sleepFn(ms);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function createIptvCatalogClient({
  baseUrl,
  fetchFn = globalThis.fetch,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const base = trimBase(baseUrl);
  if (!base) throw new Error('IPTV catalog client requires baseUrl');

  async function request(path, { signal = null } = {}) {
    throwIfAborted(signal);
    const response = await fetchFn(`${base}${path}`, {
      headers: { accept: 'application/json' },
      signal: signal || undefined,
    });
    if (!response?.ok) throw new Error(`IPTV relay ${path} failed with HTTP ${response?.status ?? 'unknown'}`);
    return response.json();
  }

  async function list(options = {}) {
    const value = await request('/catalog', options);
    if (!value || !Array.isArray(value.channels) || !Array.isArray(value.categories)) {
      throw new Error('Invalid IPTV catalog response');
    }
    return value;
  }

  async function account(options = {}) {
    const value = await request('/account', options);
    return {
      auth: nonNegativeInt(value?.auth, 0),
      status: String(value?.status || ''),
      activeConnections: nonNegativeInt(value?.activeConnections, 0),
      maxConnections: nonNegativeInt(value?.maxConnections, 0),
      allowedOutputFormats: Array.isArray(value?.allowedOutputFormats) ? [...value.allowedOutputFormats] : [],
    };
  }

  async function waitForFreeSlot({ timeoutMs = 15_000, pollMs = 500, signal = null } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    do {
      throwIfAborted(signal);
      last = await account({ signal });
      if (last.activeConnections === 0) return last;
      await sleep(pollMs, signal, sleepFn);
    } while (Date.now() < deadline);
    throw new Error(`Provider slot still busy (${last?.activeConnections ?? 'unknown'}/${last?.maxConnections ?? 'unknown'})`);
  }

  async function stats(options = {}) {
    return request('/stats', options);
  }

  return Object.freeze({ list, account, waitForFreeSlot, stats });
}
