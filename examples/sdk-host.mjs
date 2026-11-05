// Optional Pi SDK example. Requires `npm install @earendil-works/pi-coding-agent`
// and configured model credentials. Not exercised in offline tests.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cwd = path.resolve(process.argv[2] || path.join(here, 'payment-service'));
const prompt = process.argv[3] || 'Review retry and idempotency risks in this project';
const extensionPath = path.join(here, '..', 'adapters', 'pi', 'extension.mjs');

async function main() {
  let sdk;
  try { sdk = await import('@earendil-works/pi-coding-agent'); }
  catch { throw new Error('Pi SDK is not installed. Run npm install @earendil-works/pi-coding-agent'); }
  const { createAgentSession, DefaultResourceLoader, SessionManager, getAgentDir } = sdk;
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    additionalExtensionPaths: [extensionPath]
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    resourceLoader,
    sessionManager: SessionManager.inMemory()
  });
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });
  try { await session.prompt(prompt); process.stdout.write('\n'); }
  finally { unsubscribe(); session.dispose(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
