// main.ts — the entrypoint: start the forge and keep serving.
//
// Two modes, one server. Local mode (no MAKEFUN_ENV_URL): bind the port the caller
// asks for (--port, else PORT, else 8080) and serve until stopped — this is what the
// kit's practice runner dials. Env mode (MAKEFUN_ENV_URL set): bind an ephemeral
// port, POST the port to the trial env's /register, then poll its /done until the env
// says the trial is over, close the server and exit 0 — the sealed grader's lifecycle.
// The bearer token comes from MAKEFUN_SHOP_TOKEN; the viewer is derived from the
// scenario seed.

import { createApp, resolveViewer } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

/** How long one register or done request may take before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The first wait between retries, and the longest. */
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

function parsePort(argv: readonly string[]): number {
  const flag = argv.indexOf('--port');
  if (flag >= 0 && argv[flag + 1] !== undefined) {
    const n = Number(argv[flag + 1]);
    if (Number.isSafeInteger(n) && n > 0 && n < 65536) return n;
  }
  const env = Number(process.env.PORT ?? '');
  if (Number.isSafeInteger(env) && env > 0 && env < 65536) return env;
  return 8080;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `attempt` failed requests: exponential from RETRY_INITIAL_MS, capped. */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer; 409 means
 * a first register already won, which is not this process's to fix. 400 and 405 are
 * contract errors and end the program; a network error or another status is retried,
 * since the env may still be starting.
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
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
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
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

async function main(): Promise<void> {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const viewer = resolveViewer();
  const server = createApp({ token, viewer });
  if (ENV_URL !== '') {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '0.0.0.0', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('the server did not bind an ephemeral TCP port');
    }
    process.stdout.write(`[entry] listening on port ${address.port} as ${viewer.login}\n`);
    await register(address.port);
    process.stdout.write('[entry] registered; waiting for the env to say done\n');
    await waitForDone();
    server.close();
    process.stdout.write('[entry] done\n');
    process.exit(0);
    return;
  }
  const port = parsePort(process.argv.slice(2));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve());
  });
  process.stdout.write(`[entry] listening on port ${port} as ${viewer.login}\n`);
}

try {
  await main();
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
