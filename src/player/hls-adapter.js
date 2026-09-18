export function createBrowserHlsFactory(HlsClass = globalThis.Hls) {
  function factory() {
    if (!HlsClass) throw new Error('hls.js runtime is unavailable');
    return new HlsClass();
  }
  factory.isSupported = () => Boolean(HlsClass?.isSupported?.());
  factory.events = { ERROR: HlsClass?.Events?.ERROR ?? 'error' };
  return factory;
}
