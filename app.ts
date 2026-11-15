// HTTP server: routing, auth, request ids, and the learn-and-lock viewer.
//
// Routes:
// - GET /healthz                        -> 200 (the runner's boot probe)
// - /api/v3[/...]                       -> REST v3 (rest.ts)
// - POST /api/graphql                   -> GraphQL (graphql.ts; batching supported)
// - POST /mcp                           -> MCP (mcp.ts)
// - /{owner}/{repo}[.git]/info/refs    -> git smart-HTTP advertisement
// - /{owner}/{repo}[.git]/git-upload-pack
// - /{owner}/{repo}[.git]/git-receive-pack
//
// Auth: REST / GraphQL / MCP require `Authorization: Bearer <token>`; the
// token is $MAKEFUN_SHOP_TOKEN when set, otherwise any non-empty Bearer
// token is accepted (local-test flexibility). Git smart-HTTP does not enforce
// auth. Every response carries a non-empty X-GitHub-Request-Id and REST
// replies are application/json, never HTML.

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { executeGraphQL } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git-http.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { type Store } from './store.ts';

const MAX_BODY_BYTES = 128 * 1024 * 1024;

interface RawBody {
  buffer: Buffer;
  tooLarge: boolean;
}

function readBody(req: IncomingMessage): Promise<RawBody> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ buffer: Buffer.concat(chunks), tooLarge }));
    req.on('error', () => resolve({ buffer: Buffer.concat(chunks), tooLarge }));
  });
}

function parseJsonBody(buffer: Buffer): { value: unknown; malformed: boolean } {
  if (buffer.length === 0) return { value: null, malformed: false };
  try {
    return { value: JSON.parse(buffer.toString('utf8')) as unknown, malformed: false };
  } catch {
    return { value: null, malformed: true };
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, headers: Record<string, string>): void {
  res.writeHead(status, { 'content-length': body.length, ...headers });
  res.end(body);
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match === null ? null : match[1];
}

function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  if (expected === undefined || expected === '') return true;
  return token === expected;
}

function decodeSegments(path: string): string[] {
  return path.split('/').map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
}

export function createAppServer(store: Store): Server {
  return createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('x-github-request-id', requestId);
    try {
      await dispatch(store, req, res);
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 500, { message: error instanceof Error ? error.message : 'internal server error' });
      } else {
        res.end();
      }
    }
  });
}

async function dispatch(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const method = req.method ?? 'GET';
  const path = url.pathname;

  if (path === '/healthz' && method === 'GET') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }
    const suffix = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
    const segments = suffix === '' ? [] : decodeSegments(suffix);
    // Learn-and-lock from /repos/{owner}/{name}.
    if (segments[0] === 'repos' && segments[1] !== undefined) store.lockViewer(segments[1]);
    const { buffer, tooLarge } = await readBody(req);
    if (tooLarge) {
      sendJson(res, 413, { message: 'request body too large' });
      return;
    }
    const { value, malformed } = parseJsonBody(buffer);
    const result = handleRest(store, {
      method,
      segments,
      query: url.searchParams,
      body: value,
      malformed,
      origin: `http://${req.headers.host ?? '127.0.0.1'}`,
    });
    if (result.status === 204) {
      res.writeHead(204);
      res.end();
      return;
    }
    if (result.rawBody !== undefined) {
      const text = result.rawBody;
      res.writeHead(result.status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(text),
        ...(result.headers ?? {}),
      });
      res.end(text);
      return;
    }
    sendJson(res, result.status, result.body, result.headers ?? {});
    return;
  }

  // GraphQL.
  if (path === '/api/graphql' && method === 'POST') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }
    const { buffer, tooLarge } = await readBody(req);
    if (tooLarge) {
      sendJson(res, 413, { errors: [{ message: 'request body too large' }] });
      return;
    }
    const { value, malformed } = parseJsonBody(buffer);
    if (malformed) {
      sendJson(res, 400, { errors: [{ message: 'malformed JSON body' }] });
      return;
    }
    const operations = Array.isArray(value) ? value : [value];
    const responses = operations.map((operation) => {
      const record = (operation ?? {}) as Record<string, unknown>;
      const query = typeof record.query === 'string' ? record.query : '';
      const variables = (record.variables ?? {}) as Record<string, unknown>;
      const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
      return executeGraphQL(store, query, variables, operationName);
    });
    sendJson(res, 200, Array.isArray(value) ? responses : responses[0]);
    return;
  }

  // MCP.
  if (path === '/mcp' && method === 'POST') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }
    const { buffer, tooLarge } = await readBody(req);
    if (tooLarge) {
      sendJson(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const result = handleMcp(store, buffer.toString('utf8'));
    if (result.body === null) {
      res.writeHead(result.status);
      res.end();
      return;
    }
    sendJson(res, result.status, result.body);
    return;
  }

  // Git smart-HTTP: /{owner}/{repo}[.git]/{info/refs,git-upload-pack,git-receive-pack}.
  const gitMatch = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch !== null) {
    const owner = decodeURIComponent(gitMatch[1] as string);
    const repoName = decodeURIComponent(gitMatch[2] as string);
    const action = gitMatch[3] as string;
    store.lockViewer(owner);
    const { buffer, tooLarge } = await readBody(req);
    if (tooLarge) {
      sendJson(res, 413, { message: 'request body too large' });
      return;
    }
    if (action === 'info/refs') {
      const service = url.searchParams.get('service') ?? '';
      const gitProtocol = req.headers['git-protocol'];
      const result = handleInfoRefs(store, owner, repoName, service, typeof gitProtocol === 'string' ? gitProtocol : undefined);
      sendRaw(res, result.status, result.body, { 'content-type': result.contentType });
      return;
    }
    if (action === 'git-upload-pack') {
      const gitProtocol = req.headers['git-protocol'];
      const result = handleUploadPack(store, owner, repoName, typeof gitProtocol === 'string' ? gitProtocol : undefined, buffer);
      sendRaw(res, result.status, result.body, { 'content-type': result.contentType });
      return;
    }
    const result = handleReceivePack(store, owner, repoName, buffer);
    sendRaw(res, result.status, result.body, { 'content-type': result.contentType });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
