// mcp.ts — the MCP endpoint (POST /mcp), Streamable HTTP, modern revision 2026-07-28.
//
// `server/discover` answers the server's identity, capabilities and supported versions in
// one request; there is no protocol-level session. `tools/list` offers the six tools the
// suite drives (create_repo, get_repo, create_issue, list_issues, create_pull_request,
// merge_pull_request), defined once as a constant so two listings are byte-identical.
// Every tool result carries BOTH structuredContent and a text block with the same JSON.
// A tool failure is reported inside the result (isError), never as an HTTP 500; an
// unknown tool is a JSON-RPC -32602; a body that is not JSON is HTTP 400 with -32700.

import {
  createIssue,
  createPull,
  listIssues,
  mergePull,
  type Repo,
  type Store,
} from './store.ts';
import { invalidateIssue, issueJson, issueObject, pullObject, repoJson } from './rest.ts';

export const MCP_REVISION = '2026-07-28';
export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';

interface McpToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, { type: string; description: string }>;
    readonly required: string[];
  };
}

/** The one tool list: a constant, so two tools/list answers are byte-identical. */
export const MCP_TOOLS: readonly McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_NAMES = new Set(MCP_TOOLS.map((tool) => tool.name));

function toolResult(result: unknown): Record<string, unknown> {
  const text = JSON.stringify(result);
  return { content: [{ type: 'text', text }], structuredContent: result };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function ownedRepo(store: Store, owner: unknown, repo: unknown): Repo | null {
  if (typeof owner !== 'string' || typeof repo !== 'string') return null;
  if (owner !== store.viewer.login) return null;
  return store.getRepo(owner, repo) ?? null;
}

function missingArgs(args: Record<string, unknown>, required: string[]): string | null {
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') return key;
  }
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === 'create_repo') {
    const missing = missingArgs(args, ['name']);
    if (missing) return toolError(`create_repo: missing required argument '${missing}'`);
    const repoName = String(args.name);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repoName)) return toolError('create_repo: invalid repository name');
    const repo = store.createRepo(
      store.viewer.login,
      repoName,
      typeof args.description === 'string' ? args.description : '',
      args.private === true,
    );
    if (repo === null) return toolError('create_repo: repository already exists');
    return toolResult(repoJson(store, repo));
  }
  if (name === 'get_repo') {
    const missing = missingArgs(args, ['owner', 'repo']);
    if (missing) return toolError(`get_repo: missing required argument '${missing}'`);
    const repo = ownedRepo(store, args.owner, args.repo);
    if (repo === null) return toolError('get_repo: repository not found');
    return toolResult(repoJson(store, repo));
  }
  if (name === 'create_issue') {
    const missing = missingArgs(args, ['owner', 'repo', 'title']);
    if (missing) return toolError(`create_issue: missing required argument '${missing}'`);
    const repo = ownedRepo(store, args.owner, args.repo);
    if (repo === null) return toolError('create_issue: repository not found');
    const issue = createIssue(store, repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
    return toolResult(JSON.parse(issueJson(store, repo, issue)));
  }
  if (name === 'list_issues') {
    const missing = missingArgs(args, ['owner', 'repo']);
    if (missing) return toolError(`list_issues: missing required argument '${missing}'`);
    const repo = ownedRepo(store, args.owner, args.repo);
    if (repo === null) return toolError('list_issues: repository not found');
    const state = typeof args.state === 'string' ? args.state : 'open';
    const issues = listIssues(repo, state).map((issue) => issueObject(store, repo, issue));
    return toolResult({ issues });
  }
  if (name === 'create_pull_request') {
    const missing = missingArgs(args, ['owner', 'repo', 'title', 'head', 'base']);
    if (missing) return toolError(`create_pull_request: missing required argument '${missing}'`);
    const repo = ownedRepo(store, args.owner, args.repo);
    if (repo === null) return toolError('create_pull_request: repository not found');
    const head = String(args.head);
    const base = String(args.base);
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.headRef === head) {
        return toolResult(pullObject(store, repo, existing));
      }
    }
    const pull = createPull(store, repo, String(args.title), typeof args.body === 'string' ? args.body : '', head, base);
    if (pull === null) return toolError('create_pull_request: head or base branch does not exist');
    return toolResult(pullObject(store, repo, pull));
  }
  if (name === 'merge_pull_request') {
    const missing = missingArgs(args, ['owner', 'repo', 'pull_number']);
    if (missing) return toolError(`merge_pull_request: missing required argument '${missing}'`);
    const repo = ownedRepo(store, args.owner, args.repo);
    if (repo === null) return toolError('merge_pull_request: repository not found');
    const pull = repo.pulls.get(Number(args.pull_number));
    if (!pull) return toolError('merge_pull_request: pull request not found');
    const result = mergePull(store, repo, pull);
    if (!result.ok) return toolError(`merge_pull_request: ${result.reason}`);
    return toolResult(pullObject(store, repo, pull));
  }
  return toolError(`unknown tool '${name}'`);
}

export interface McpResponse {
  readonly status: number;
  readonly body: string;
}

/**
 * POST /mcp. `bodyText` is the raw request body; a body that is not JSON is answered
 * HTTP 400 with JSON-RPC -32700. Returns a plain JSON-RPC response (never SSE).
 */
export function handleMcp(store: Store, bodyText: string): McpResponse {
  const rpcError = (id: unknown, code: number, message: string): McpResponse => ({
    status: 200,
    body: `${JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })}\n`,
  });
  let request: unknown;
  try {
    request = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      body: `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: body is not JSON' } })}\n`,
    };
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object');
  }
  const { method, params, id } = request as { method?: unknown; params?: unknown; id?: unknown };
  if (typeof method !== 'string') return rpcError(id, -32600, 'Invalid Request: missing method');
  const hasId = id !== undefined && id !== null;
  // Notifications carry no id and get no JSON-RPC answer.
  if (!hasId && method.startsWith('notifications/')) {
    return { status: 202, body: '' };
  }
  const result = (value: unknown): McpResponse => ({
    status: 200,
    body: `${JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result: value })}\n`,
  });
  const serverInfo = { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };

  if (method === 'server/discover') {
    return result({
      supportedVersions: [MCP_REVISION, '2025-11-25'],
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }
  if (method === 'initialize') {
    const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    return result({
      protocolVersion: typeof requested === 'string' ? requested : MCP_REVISION,
      capabilities: { tools: {} },
      serverInfo,
    });
  }
  if (method === 'tools/list') {
    return result({ tools: MCP_TOOLS });
  }
  if (method === 'tools/call') {
    const args = (params ?? {}) as { name?: unknown; arguments?: unknown };
    if (typeof args.name !== 'string') return rpcError(id, -32602, 'tools/call needs a tool name');
    if (!TOOL_NAMES.has(args.name)) return rpcError(id, -32602, `unknown tool '${args.name}'`);
    const toolArgs = (args.arguments ?? {}) as Record<string, unknown>;
    if (toolArgs === null || typeof toolArgs !== 'object' || Array.isArray(toolArgs)) {
      return rpcError(id, -32602, 'tools/call arguments must be an object');
    }
    return result(callTool(store, args.name, toolArgs));
  }
  if (method.startsWith('notifications/')) {
    return { status: 202, body: '' };
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}
