import { createRelay, readRelayConfig, qqTransportOptions } from './core.mjs';
import { createRelayHttpServer } from './http.mjs';
import { readRelayRuntime } from './runtime.mjs';

async function main() {
  const { host, port, mode } = readRelayRuntime(process.env);
  const config = readRelayConfig(process.env);
  const { default: nodemailer } = await import('nodemailer');
  const transport = nodemailer.createTransport(qqTransportOptions(config));
  const relay = createRelay({ env: process.env, sendMail: message => transport.sendMail(message) });
  const server = createRelayHttpServer(relay);
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    const listenerClosed = new Promise(resolveClose => server.close(resolveClose));
    server.closeIdleConnections();
    // Leave the host's 30-second SIGTERM budget headroom. SQLite reservations become unknown before exit.
    const deadline = setTimeout(() => { server.closeAllConnections(); transport.close(); }, 20000);
    try {
      await relay.close({ timeoutMs: 18000 });
      transport.close(); server.closeAllConnections();
      await listenerClosed;
    } finally { clearTimeout(deadline); }
  }
  process.once('SIGINT', () => { stop().then(() => process.exit(0), () => process.exit(1)); });
  process.once('SIGTERM', () => { stop().then(() => process.exit(0), () => process.exit(1)); });
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(port, host, resolveListen);
    });
  } catch {
    await relay.close(); transport.close();
    throw new Error('Relay listener is unavailable.');
  }
  console.info(`QQ mail relay started (${mode}); SMTP is used only after an authenticated /send request.`);
}

main().catch(() => {
  console.error('QQ relay could not start. Check private environment settings, dependency installation, and listener/persistent ledger availability.');
  process.exitCode = 1;
});
