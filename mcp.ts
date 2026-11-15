// MCP (`/mcp`) — JSON-RPC 2.0, modern 2026-07-28 era (`server/discover`)
// with the legacy `initialize` handshake as a fallback path.
//
// Contract (from mcp-client.ts / checks-mcp.ts):
// - `server/discover` returns supportedVersions (YYYY-MM-DD, must include
//   2026-07-28), capabilities.tools, and serverInfo.name/version, both
//   top-level and under `_meta['io.modelcontextprotocol/serverInfo']`;
// - `initialize` answers protocolVersion + capabilities + serverInfo;
// - `tools/list` returns a constant array (byte-identical across calls);
// - `tools/call` results carry both content text (JSON) and structuredContent;
// - unknown tool -> JSON-RPC -32601; missing required args -> isError:true;
// - non-JSON body -> HTTP 400 with JSON-RPC -32700; auth is enforced by app.ts.

import { restIssueJson, restPullJson, restRepoJson, type Store } from './store.ts';

export interface McpResult {
  status: number;
  body: unknown;
}

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-06-18', '2025-03-26'];

const TOOLS: Record<string, unknown>[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
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
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
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
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
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
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const REQUIRED_ARGS: Record<string, string[]> = {
  create_repo: ['name'],
  get_repo: ['owner', 'repo'],
  create_issue: ['owner', 'repo', 'title'],
  list_issues: ['owner', 'repo'],
  create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
  merge_pull_request: ['owner', 'repo', 'pull_number'],
};

function serverInfo(): { name: string; version: string } {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

function toolResult(data: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const required = REQUIRED_ARGS[name];
  if (required !== undefined) {
    const missing = required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) return toolError(`missing required argument(s): ${missing.join(', ')}`);
  }
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repoName = typeof args.repo === 'string' ? args.repo : '';

  if (name === 'create_repo') {
    const repo = store.createRepo(
      store.viewerLogin,
      typeof args.name === 'string' ? args.name : '',
      args.private === true,
      typeof args.description === 'string' ? args.description : '',
    );
    if (repo === null) return toolError('a repository with this name already exists');
    return toolResult(restRepoJson(repo));
  }

  if (owner !== store.viewerLogin) return toolError('repository not found');
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return toolError('repository not found');

  if (name === 'get_repo') return toolResult(restRepoJson(repo));

  if (name === 'create_issue') {
    const created = store.createIssue(repo, typeof args.title === 'string' ? args.title : '', typeof args.body === 'string' ? args.body : '', []);
    if ('error' in created) return toolError(created.error);
    return toolResult(restIssueJson(repo, created));
  }

  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    let list = [...repo.issues.values()];
    if (state === 'open') list = list.filter((issue) => issue.state === 'open');
    else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
    list.sort((a, b) => b.number - a.number);
    return toolResult({ issues: list.map((issue) => restIssueJson(repo, issue)) });
  }

  if (name === 'create_pull_request') {
    const created = store.createPull(
      repo,
      typeof args.title === 'string' ? args.title : '',
      '',
      typeof args.head === 'string' ? args.head : '',
      typeof args.base === 'string' ? args.base : repo.defaultBranch,
    );
    if ('error' in created) return toolError(created.error);
    return toolResult(restPullJson(repo, created));
  }

  if (name === 'merge_pull_request') {
    const number = Number(args.pull_number);
    const pull = repo.pulls.get(number);
    if (pull === undefined) return toolError('pull request not found');
    const merged = store.mergePullSquash(repo, pull);
    if (!merged.ok) return toolError(merged.message);
    return toolResult({ merged: true, sha: merged.sha, number: pull.number });
  }

  return toolError(`unknown tool: ${name}`);
}

export function handleMcp(store: Store, bodyText: string): McpResult {
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;
  const hasId = request.id !== undefined && request.id !== null;

  const ok = (result: unknown): McpResult => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
  const rpcError = (code: number, message: string): McpResult => ({ status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } });

  // Notifications (no id) get a bare 202 and no JSON-RPC body.
  if (!hasId) {
    return { status: 202, body: null };
  }

  if (method === 'server/discover') {
    return ok({
      protocolVersion: '2026-07-28',
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
    });
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' && SUPPORTED_VERSIONS.includes(params.protocolVersion)
      ? params.protocolVersion
      : '2026-07-28';
    return ok({
      protocolVersion: offered,
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
    });
  }

  if (method === 'ping') return ok({});

  if (method === 'tools/list') {
    return ok({ tools: TOOLS });
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (REQUIRED_ARGS[toolName] === undefined) {
      return rpcError(-32601, `Method not found: tools/call ${toolName}`);
    }
    return ok(callTool(store, toolName, args));
  }

  return rpcError(-32601, `Method not found: ${method}`);
}
