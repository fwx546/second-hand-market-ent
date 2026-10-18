import { isAbsolute, parse, relative, resolve, sep } from 'node:path';

const invalid = () => { throw new Error('QQ relay runtime configuration is invalid. See relay/README.md.'); };
function portNumber(value) {
  if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65535) invalid();
  return Number(value);
}
function publicOrigin(value) {
  if (typeof value !== 'string') invalid();
  let url;
  try { url = new URL(value); } catch { invalid(); }
  const host = url.hostname;
  if (value !== url.origin || url.protocol !== 'https:' || url.username || url.password || url.port ||
      host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ||
      /(?:^|\.)(?:localhost|local|localdomain|internal|test|invalid|example)$/.test(host)) invalid();
  return url.origin;
}

/** Production is opt-in; a platform PORT or NODE_ENV alone never opens the local runner. */
export function readRelayRuntime(env = {}) {
  const mode = env.JUZI_RELAY_MODE?.trim() || 'local';
  if (mode === 'local') {
    if ((env.QQ_RELAY_HOST?.trim() || '127.0.0.1') !== '127.0.0.1') invalid();
    return { mode, host: '127.0.0.1', port: portNumber(env.QQ_RELAY_PORT?.trim() || '4180'), publicOrigin: null, filename: null, dataDirectory: null };
  }
  if (mode !== 'production' || env.NODE_ENV !== 'production' || env.QQ_RELAY_HOST || env.QQ_RELAY_PORT) invalid();
  const configuredOrigin = env.JUZI_RELAY_PUBLIC_ORIGIN || (env.RENDER === 'true' ? env.RENDER_EXTERNAL_URL : undefined);
  const origin = publicOrigin(configuredOrigin);
  const dataDirectory = env.QQ_RELAY_DATA_DIR?.trim(), configuredPath = env.QQ_RELAY_DB_PATH?.trim();
  if (!dataDirectory || !configuredPath || !isAbsolute(dataDirectory) || !isAbsolute(configuredPath)) invalid();
  const dataRoot = resolve(dataDirectory), filename = resolve(configuredPath), within = relative(dataRoot, filename);
  // A dedicated mounted directory is required. Never fall back to the ephemeral checkout or :memory:.
  if (dataRoot === parse(dataRoot).root || !within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) invalid();
  return { mode, host: '0.0.0.0', port: portNumber(env.PORT?.trim() || '10000'), publicOrigin: origin, filename, dataDirectory: dataRoot };
}
