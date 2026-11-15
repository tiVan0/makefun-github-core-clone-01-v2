// app.ts — the HTTP server: one process serving the health probe, the git smart-HTTP
// surface, REST v3, GraphQL and MCP from the same in-memory store.
//
// Auth: every route but /healthz needs `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`.
// When the token is not configured, the first non-empty bearer token locks in as the
// expected one (the sealed env always sets it; local runs set it too). A missing or
// wrong token is 401; a foreign owner is 404, never 403. Every response carries a
// non-empty X-GitHub-Request-Id, and every /api/v3 reply is JSON.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { deriveViewer, type ViewerUser } from './scenario.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git-http.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function newRequestId(): string {
  requestCounter += 1;
  return `req-${Date.now().toString(36)}-${requestCounter.toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`;
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': newRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': newRequestId(),
    ...headers,
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export interface AppConfig {
  readonly token: string;
  readonly viewer: ViewerUser;
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(config: AppConfig): Server {
  const store = new Store(config.viewer);
  let expectedToken = config.token;
  let tokenLocked = expectedToken !== '';

  const authorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return false;
    const presented = header.slice('Bearer '.length).trim();
    if (presented === '') return false;
    if (!tokenLocked) {
      expectedToken = presented;
      tokenLocked = true;
      return true;
    }
    return presented === expectedToken;
  };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const path = pathOf(req);
      const segments = path.split('/').filter((segment) => segment !== '');

      // The env's boot check calls this twice: 200 {"ok":true}. No auth.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (!authorized(req)) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return;
      }

      // REST v3.
      if (segments[0] === 'api' && segments[1] === 'v3') {
        let body: unknown = undefined;
        if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
          const raw = await readBody(req);
          if (raw.length > 0) {
            try {
              body = JSON.parse(raw.toString('utf8'));
            } catch {
              sendJson(res, 400, { message: 'malformed JSON body' });
              return;
            }
          }
        }
        const host = req.headers.host ?? '127.0.0.1';
        const restReq: RestRequest = {
          method,
          segments: ['api', 'v3', ...segments.slice(2)],
          query: queryOf(req),
          body,
          origin: `http://${host}`,
        };
        const answered = handleRest(store, restReq);
        if (answered === null) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (answered.status === 204) {
          res.writeHead(204, { 'x-github-request-id': newRequestId() });
          res.end();
          return;
        }
        sendJson(res, answered.status, answered.body, answered.headers);
        return;
      }

      // GraphQL.
      if (method === 'POST' && path === '/api/graphql') {
        const raw = await readBody(req);
        let body: unknown;
        try {
          body = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : {};
        } catch {
          sendJson(res, 400, { errors: [{ message: 'request body is not valid JSON' }] });
          return;
        }
        const answered = handleGraphQL(store, body);
        sendJson(res, answered.status, answered.body);
        return;
      }

      // MCP.
      if (method === 'POST' && path === '/mcp') {
        const raw = await readBody(req);
        const answered = handleMcp(store, raw.toString('utf8'));
        if (answered.status === 202) {
          res.writeHead(202, { 'x-github-request-id': newRequestId() });
          res.end();
          return;
        }
        sendJson(res, answered.status, answered.body);
        return;
      }

      // Git smart HTTP: /<owner>/<repo>.git/...
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
      if (gitMatch) {
        const owner = decodeURIComponent(gitMatch[1]);
        const repoName = decodeURIComponent(gitMatch[2]);
        const suffix = gitMatch[3] ?? '';
        const query = queryOf(req);
        const respond = (status: number, contentType: string, body: Buffer): void => {
          sendBytes(res, status, contentType, body);
        };
        if (method === 'GET' && suffix === '/info/refs') {
          const service = query.get('service');
          if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
            sendJson(res, 400, { message: 'unknown service' });
            return;
          }
          const gitProtocolHeader = req.headers['git-protocol'];
          handleInfoRefs(store, owner, repoName, service, Array.isArray(gitProtocolHeader) ? gitProtocolHeader.join(',') : gitProtocolHeader, respond);
          return;
        }
        if (method === 'POST' && suffix === '/git-upload-pack') {
          const raw = await readBody(req);
          handleUploadPack(store, owner, repoName, raw, respond);
          return;
        }
        if (method === 'POST' && suffix === '/git-receive-pack') {
          const raw = await readBody(req);
          handleReceivePack(store, owner, repoName, raw, respond);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      // Everything else: GitHub's 404 body.
      sendJson(res, 404, { message: 'Not Found' });
    })().catch((err: unknown) => {
      if (!res.headersSent) {
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
        } catch {
          // The response is already gone; nothing left to do.
        }
      }
    });
  });
}

/** The viewer for this process: derived from the scenario seed, or learn-and-lock. */
export function resolveViewer(): ViewerUser {
  return deriveViewer() ?? { id: 1000, login: 'viewer', name: 'viewer', email: 'viewer@example.invalid' };
}
