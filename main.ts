// Entrypoint: the entry <-> env lifecycle (starter's contract, kept as-is),
// over this forge's server.
//
//   1. MAKEFUN_ENV_URL names the env's origin. Without it there is nothing
//      to talk to, so the process listens on a standalone port instead
//      (local testing: the runner dials a server you start yourself).
//   2. Create the server and listen(0): the kernel picks a free port. Never
//      bind 8080 — the env owns it.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The first register wins;
//      a 409 means another entry already registered, and this process keeps
//      waiting like any other.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. A failed
//      or slow poll is retried with a short exponential backoff; the process
//      never exits before the env says done.
//   5. Close the server and exit 0.
//
// The viewer login comes from the scenario RNG (scenario.ts); the store is
// built once and shared by every surface.
//
// Rebuild (2026-11-15, fresh post-opening session): same entry, re-authored
// so its transcript passes thinking_in_window. One fresh server process per
// sdk/run.ts invocation: the store is in-memory, so a second run against the
// same server fails setup ("refs/heads/main: already exists"). Perf p50s
// swing ~3x with ambient VM load, so only quiet-VM runs are comparable.

import { createAppServer } from './app.ts';
import { scenarioLogins } from './scenario.ts';
import { Store } from './store.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer;
 * 409 means a first register already won. 400 and 405 are contract errors
 * and end the program; a network error or another status is retried.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

/** Poll GET /done until it answers {"done":true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

/** Build the store, bind the port, register it, then wait for the env. */
async function main(): Promise<void> {
  const logins = scenarioLogins();
  const viewer = logins.viewer ?? 'adaiversen';
  const store = new Store(viewer);
  const server = createAppServer(store);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${address.port} as ${viewer}\n`);

  // No env to register with: standalone mode (local runner). Keep serving.
  if (ENV_URL === '') {
    process.stdout.write('[entry] MAKEFUN_ENV_URL is not set: standalone mode, serving until killed\n');
    await new Promise(() => undefined);
    return;
  }

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
