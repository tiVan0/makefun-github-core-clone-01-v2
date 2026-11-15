// rest.ts — the GitHub REST v3 surface under /api/v3.
//
// Every reply is JSON (never HTML), carries a non-empty X-GitHub-Request-Id, and a
// missing token is 401 while a foreign owner is 404, never 403. A repository belongs to
// the login the token names; the same name under another login is not this token's to
// read. Issue bodies are pre-serialised per issue and served from that cache on the
// single-issue read path, which is the timed read workload.

import {
  blobAtPath,
  commitFileChange,
  createIssue,
  createPull,
  diffTrees,
  globalId,
  listIssues,
  mergePull,
  readPathAtCommit,
  treeAtPath,
  treeOfCommit,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { DEFAULT_BRANCH } from './scenario.ts';

export interface RestResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export interface RestRequest {
  readonly method: string;
  readonly segments: string[];
  readonly query: URLSearchParams;
  readonly body: unknown;
  readonly origin: string;
}

function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): RestResponse {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders }, body: `${JSON.stringify(body)}\n` };
}

function rawJsonResponse(status: number, body: string, extraHeaders: Record<string, string> = {}): RestResponse {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders }, body };
}

function error(status: number, message: string): RestResponse {
  return jsonResponse(status, { message });
}

function notFound(): RestResponse {
  return error(404, 'Not Found');
}

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: store.viewer.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    html_url: `https://github.com/${repo.fullName}`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    git_url: `git://github.com/${repo.fullName}.git`,
    ssh_url: `git@github.com:${repo.fullName}.git`,
    homepage: null,
    language: null,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    license: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

export function issueObject(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: '' };
    }),
    user: { login: issue.userLogin, id: store.viewer.id, type: 'User' },
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.fullName}`,
    labels_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments`,
    author_association: 'OWNER',
  };
}

/** The pre-serialised issue body; rebuilt only when the issue changes. */
export function issueJson(store: Store, repo: Repo, issue: Issue): string {
  if (issue.jsonCache === null) issue.jsonCache = `${JSON.stringify(issueObject(store, repo, issue))}\n`;
  return issue.jsonCache;
}

export function invalidateIssue(issue: Issue): void {
  issue.jsonCache = null;
}

export function pullObject(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: null,
    mergeable_state: 'unknown',
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: pull.userLogin, id: store.viewer.id, type: 'User' },
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    labels: [],
    milestone: null,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
    diff_url: `https://github.com/${repo.fullName}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${repo.fullName}/pull/${pull.number}.patch`,
    author_association: 'OWNER',
  };
}

function commentObject(store: Store, repo: Repo, issue: Issue, comment: Issue['comments'][number]): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', repo.id, issue.number, comment.id),
    body: comment.body,
    user: { login: comment.userLogin, id: store.viewer.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments/${comment.id}`,
    issue_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    author_association: 'OWNER',
  };
}

function asObject(body: unknown): Record<string, unknown> | null {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function labelNames(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const names: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') names.push(item);
    else if (item !== null && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
      names.push((item as { name: string }).name);
    } else return null;
  }
  return names;
}

/** The repository a /repos/:owner/:name route names, or null (404, never 403). */
function ownedRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== store.viewer.login) return null;
  return store.getRepo(owner, name) ?? null;
}

// -----------------------------------------------------------------------------------------
// routing
// -----------------------------------------------------------------------------------------

/** Route one /api/v3 request. Returns null when the path is not an /api/v3 route. */
export function handleRest(store: Store, req: RestRequest): RestResponse | null {
  const { method, segments } = req;
  if (segments.length === 0 || segments[0] !== 'api' || segments[1] !== 'v3') return null;

  // GET /api/v3/ — the API root.
  if ((segments.length === 2 || (segments.length === 3 && segments[2] === '')) && method === 'GET') {
    return jsonResponse(
      200,
      {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        user_repositories_url: '/api/v3/user/repos',
      },
      { 'x-oauth-scopes': 'repo, read:org', 'x-accepted-oauth-scopes': 'repo, read:org' },
    );
  }
  // GET /api/v3/meta
  if (segments.length === 3 && segments[2] === 'meta' && method === 'GET') {
    return jsonResponse(200, { installed_version: '1.0.0' });
  }
  // GET /api/v3/user
  if (segments.length === 3 && segments[2] === 'user' && method === 'GET') {
    const viewer = store.viewer;
    return jsonResponse(200, {
      login: viewer.login,
      id: viewer.id,
      node_id: globalId('User', viewer.id),
      name: viewer.name,
      email: viewer.email,
      type: 'User',
      html_url: `https://github.com/${viewer.login}`,
      url: '/api/v3/user',
    });
  }
  // /api/v3/user/repos
  if (segments.length === 4 && segments[2] === 'user' && segments[3] === 'repos') {
    if (method === 'GET') return listUserRepos(store, req);
    if (method === 'POST') return createUserRepo(store, req);
    return error(405, 'Method Not Allowed');
  }
  // /api/v3/repos/:owner/:name[/...]
  if (segments.length >= 4 && segments[2] === 'repos') {
    return handleRepoRoute(store, req);
  }
  return notFound();
}

function listUserRepos(store: Store, req: RestRequest): RestResponse {
  const all = store.listRepos(store.viewer.login);
  const perPageRaw = Number(req.query.get('per_page') ?? '30');
  const perPage = Number.isSafeInteger(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  const pageRaw = Number(req.query.get('page') ?? '1');
  const page = Number.isSafeInteger(pageRaw) ? Math.max(1, pageRaw) : 1;
  const totalPages = Math.max(1, Math.ceil(all.length / perPage));
  const start = (page - 1) * perPage;
  const slice = all.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (page < totalPages) {
    const next = `${req.origin}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
    const last = `${req.origin}/api/v3/user/repos?per_page=${perPage}&page=${totalPages}`;
    headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  return jsonResponse(200, slice.map((repo) => repoJson(store, repo)), headers);
}

function createUserRepo(store: Store, req: RestRequest): RestResponse {
  const body = asObject(req.body);
  const name = body ? asString(body.name) : null;
  if (name === null || name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
    return error(422, 'name is invalid');
  }
  const description = body ? asString(body.description) ?? '' : '';
  const isPrivate = body ? body.private === true : false;
  const repo = store.createRepo(store.viewer.login, name, description, isPrivate);
  if (repo === null) return error(422, 'Repository already exists');
  return jsonResponse(201, repoJson(store, repo));
}

// -----------------------------------------------------------------------------------------
// /api/v3/repos/:owner/:name
// -----------------------------------------------------------------------------------------

function handleRepoRoute(store: Store, req: RestRequest): RestResponse {
  const { method, segments } = req;
  const owner = segments[3];
  const name = segments[4];
  if (name === undefined || name === '') return notFound();
  const repo = ownedRepo(store, owner, name);
  if (repo === null) return notFound();
  const rest = segments.slice(5);

  if (rest.length === 0) {
    if (method === 'GET') return jsonResponse(200, repoJson(store, repo));
    if (method === 'PATCH') {
      const body = asObject(req.body);
      if (body && typeof body.description === 'string') repo.description = body.description;
      return jsonResponse(200, repoJson(store, repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, name);
      return { status: 204, headers: {}, body: '' };
    }
    return error(405, 'Method Not Allowed');
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) return createGitRef(store, repo, req);
    if (method === 'GET' && rest.length === 4 && rest[2] === 'heads') return getGitRefHead(store, repo, rest[3]);
    return notFound();
  }
  if (rest[0] === 'branches') {
    if (method === 'GET' && rest.length === 1) return listBranches(store, repo);
    if (method === 'GET' && rest.length === 2) return getBranch(store, repo, rest[1]);
    return notFound();
  }
  if (rest[0] === 'commits') {
    if (method === 'GET' && rest.length === 1) return listCommits(store, repo, req);
    return notFound();
  }
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'PUT') return putContents(store, repo, req, path);
    if (method === 'GET') return getContents(store, repo, req, path);
    if (method === 'DELETE') return deleteContents(store, repo, req, path);
    return notFound();
  }
  if (rest[0] === 'labels') {
    if (method === 'POST' && rest.length === 1) return createLabel(store, repo, req);
    if (method === 'GET' && rest.length === 1) {
      return jsonResponse(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
    }
    return notFound();
  }
  if (rest[0] === 'issues') return handleIssues(store, repo, req, rest.slice(1));
  if (rest[0] === 'pulls') return handlePulls(store, repo, req, rest.slice(1));
  return notFound();
}

function createGitRef(store: Store, repo: Repo, req: RestRequest): RestResponse {
  const body = asObject(req.body);
  const ref = body ? asString(body.ref) : null;
  const sha = body ? asString(body.sha) : null;
  if (ref === null || !ref.startsWith('refs/') || sha === null) return error(422, 'ref and sha are required');
  if (repo.refs.has(ref)) return error(422, 'Reference already exists');
  if (!repo.objects.has(sha)) return error(422, 'sha does not exist');
  store.setRef(repo, ref, sha);
  return jsonResponse(201, { ref, object: { sha }, url: `/api/v3/repos/${repo.fullName}/git/refs/${encodeURIComponent(ref)}` });
}

function getGitRefHead(store: Store, repo: Repo, branch: string): RestResponse {
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (sha === undefined) return notFound();
  return jsonResponse(200, { ref: `refs/heads/${branch}`, object: { sha } });
}

function listBranches(store: Store, repo: Repo): RestResponse {
  const out: Array<Record<string, unknown>> = [];
  const names = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).sort();
  for (const ref of names) {
    out.push({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) } });
  }
  return jsonResponse(200, out);
}

function getBranch(store: Store, repo: Repo, branch: string): RestResponse {
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (sha === undefined) return notFound();
  return jsonResponse(200, { name: branch, commit: { sha } });
}

function listCommits(store: Store, repo: Repo, req: RestRequest): RestResponse {
  const shaParam = req.query.get('sha');
  const tip = shaParam ? store.resolveRef(repo, shaParam) : repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (tip === null) return jsonResponse(200, []);
  const commits = store.listCommits(repo, tip);
  const out = commits.map((commit) => ({
    sha: commit.sha,
    node_id: globalId('Commit', commit.sha),
    commit: {
      message: commit.message,
      author: { name: store.viewer.name, email: store.viewer.email, date: new Date(commit.timestamp * 1000).toISOString() },
      committer: { name: store.viewer.name, email: store.viewer.email, date: new Date(commit.timestamp * 1000).toISOString() },
    },
    author: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
    committer: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
    parents: commit.parents.map((parent) => ({ sha: parent })),
    html_url: `https://github.com/${repo.fullName}/commit/${commit.sha}`,
    url: `/api/v3/repos/${repo.fullName}/commits/${commit.sha}`,
  }));
  return jsonResponse(200, out);
}

// -----------------------------------------------------------------------------------------
// contents
// -----------------------------------------------------------------------------------------

function putContents(store: Store, repo: Repo, req: RestRequest, path: string): RestResponse {
  const body = asObject(req.body);
  if (body === null) return error(400, 'body must be a JSON object');
  const contentB64 = asString(body.content);
  const message = asString(body.message) ?? `Update ${path}`;
  const branch = asString(body.branch) ?? undefined;
  const shaParam = asString(body.sha) ?? null;
  if (contentB64 === null) return error(422, 'content is required');
  let content: Buffer;
  try {
    content = Buffer.from(contentB64, 'base64');
  } catch {
    return error(422, 'content is not valid base64');
  }
  const refName = `refs/heads/${branch ?? repo.defaultBranch}`;
  const tip = repo.refs.get(refName) ?? null;
  const currentBlob = tip ? blobAtPath(store, repo, treeOfCommit(store, repo, tip) ?? '', path) : null;
  const isUpdate = currentBlob !== null;
  if (isUpdate && shaParam === null) return error(422, 'sha is required to update a file');
  if (isUpdate && shaParam !== currentBlob) return error(409, 'sha does not match the current blob');
  if (!isUpdate && shaParam !== null) return error(409, 'sha does not match: the file does not exist yet');
  const result = commitFileChange(store, repo, { branch, path, content, message });
  if (result === null) return error(422, 'branch could not be resolved');
  const blob = result.blobOid ? repo.objects.get(result.blobOid) : null;
  return jsonResponse(isUpdate ? 200 : 201, {
    content: {
      name: path.split('/').pop() ?? path,
      path,
      sha: result.blobOid,
      size: blob ? blob.data.length : 0,
      type: 'file',
      encoding: 'base64',
      content: contentB64,
    },
    commit: { sha: result.commitOid, message },
  });
}

function getContents(store: Store, repo: Repo, req: RestRequest, path: string): RestResponse {
  const refParam = req.query.get('ref');
  const tip = refParam ? store.resolveRef(repo, refParam) : repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (tip === null) return notFound();
  const found = readPathAtCommit(store, repo, tip, path);
  if (found === null) return notFound();
  if (found.kind === 'file') {
    return jsonResponse(200, {
      name: path.split('/').pop() ?? path,
      path,
      sha: found.oid,
      size: found.data.length,
      type: 'file',
      encoding: 'base64',
      content: found.data.toString('base64'),
    });
  }
  const entries = found.entries.map((entry) => ({
    name: entry.name,
    path: path === '' ? entry.name : `${path}/${entry.name}`,
    sha: entry.oid,
    size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
    type: entry.mode === '40000' ? 'dir' : 'file',
  }));
  return jsonResponse(200, entries);
}

function deleteContents(store: Store, repo: Repo, req: RestRequest, path: string): RestResponse {
  const body = asObject(req.body);
  const message = body ? asString(body.message) ?? `Delete ${path}` : `Delete ${path}`;
  const branch = body ? asString(body.branch) ?? undefined : undefined;
  const shaParam = body ? asString(body.sha) ?? null : null;
  const refName = `refs/heads/${branch ?? repo.defaultBranch}`;
  const tip = repo.refs.get(refName) ?? null;
  if (tip === null) return notFound();
  const currentBlob = blobAtPath(store, repo, treeOfCommit(store, repo, tip) ?? '', path);
  if (currentBlob === null) return notFound();
  if (shaParam !== null && shaParam !== currentBlob) return error(409, 'sha does not match the current blob');
  const result = commitFileChange(store, repo, { branch, path, content: null, message });
  if (result === null) return error(422, 'branch could not be resolved');
  return jsonResponse(200, { commit: { sha: result.commitOid, message } });
}

function createLabel(store: Store, repo: Repo, req: RestRequest): RestResponse {
  const body = asObject(req.body);
  const name = body ? asString(body.name) : null;
  if (name === null || name === '') return error(422, 'name is required');
  if (repo.labels.has(name)) return error(422, 'Label already exists');
  const color = body ? asString(body.color) ?? 'ededed' : 'ededed';
  repo.labels.set(name, { name, color });
  return jsonResponse(201, { name, color, description: '' });
}

// -----------------------------------------------------------------------------------------
// issues
// -----------------------------------------------------------------------------------------

function handleIssues(store: Store, repo: Repo, req: RestRequest, rest: string[]): RestResponse {
  const { method } = req;
  if (rest.length === 0) {
    if (method === 'POST') return createIssueRoute(store, repo, req);
    if (method === 'GET') return listIssuesRoute(store, repo, req);
    return error(405, 'Method Not Allowed');
  }
  const number = Number(rest[0]);
  if (!Number.isSafeInteger(number) || number < 1) return notFound();
  const issue = repo.issues.get(number);
  if (issue === undefined) return notFound();
  if (rest.length === 1) {
    if (method === 'GET') return rawJsonResponse(200, issueJson(store, repo, issue));
    if (method === 'PATCH') return patchIssueRoute(store, repo, issue, req);
    return error(405, 'Method Not Allowed');
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'POST') return createCommentRoute(store, repo, issue, req);
    if (method === 'GET') {
      return jsonResponse(200, issue.comments.map((comment) => commentObject(store, repo, issue, comment)));
    }
    return error(405, 'Method Not Allowed');
  }
  return notFound();
}

function createIssueRoute(store: Store, repo: Repo, req: RestRequest): RestResponse {
  const body = asObject(req.body);
  const title = body ? asString(body.title) : null;
  if (title === null || title === '') return error(422, 'title is required');
  const labels = body && body.labels !== undefined ? labelNames(body.labels) : [];
  if (labels === null) return error(422, 'labels must be an array of names');
  for (const name of labels) {
    if (!repo.labels.has(name)) return error(422, `Label '${name}' does not exist`);
  }
  const issue = createIssue(store, repo, title, asString(body?.body) ?? '', labels);
  return jsonResponse(201, JSON.parse(issueJson(store, repo, issue)));
}

function listIssuesRoute(store: Store, repo: Repo, req: RestRequest): RestResponse {
  const state = req.query.get('state') ?? 'open';
  const sort = req.query.get('sort') ?? 'created';
  const direction = req.query.get('direction') ?? 'desc';
  let issues = listIssues(repo, state);
  if (sort === 'created') {
    issues = [...issues].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  }
  return jsonResponse(200, issues.map((issue) => JSON.parse(issueJson(store, repo, issue))));
}

function patchIssueRoute(store: Store, repo: Repo, issue: Issue, req: RestRequest): RestResponse {
  const body = asObject(req.body);
  if (body === null) return error(400, 'body must be a JSON object');
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (typeof body.state === 'string') {
    if (body.state === 'closed' && issue.state !== 'closed') {
      issue.state = 'closed';
      issue.closedAt = new Date().toISOString();
    } else if (body.state === 'open' && issue.state !== 'open') {
      issue.state = 'open';
      issue.closedAt = null;
    }
  }
  if (body.labels !== undefined) {
    const labels = labelNames(body.labels);
    if (labels === null) return error(422, 'labels must be an array of names');
    for (const name of labels) {
      if (!repo.labels.has(name)) return error(422, `Label '${name}' does not exist`);
    }
    issue.labels = labels;
  }
  issue.updatedAt = new Date().toISOString();
  invalidateIssue(issue);
  return jsonResponse(200, JSON.parse(issueJson(store, repo, issue)));
}

function createCommentRoute(store: Store, repo: Repo, issue: Issue, req: RestRequest): RestResponse {
  const body = asObject(req.body);
  const text = body ? asString(body.body) : null;
  if (text === null) return error(422, 'body is required');
  repo.commentCounter += 1;
  const comment = {
    id: repo.commentCounter,
    body: text,
    userLogin: store.viewer.login,
    createdAt: new Date().toISOString(),
  };
  issue.comments.push(comment);
  return jsonResponse(201, commentObject(store, repo, issue, comment));
}

// -----------------------------------------------------------------------------------------
// pull requests
// -----------------------------------------------------------------------------------------

function handlePulls(store: Store, repo: Repo, req: RestRequest, rest: string[]): RestResponse {
  const { method } = req;
  if (rest.length === 0) {
    if (method === 'POST') return createPullRoute(store, repo, req);
    if (method === 'GET') return listPullsRoute(store, repo, req);
    return error(405, 'Method Not Allowed');
  }
  const number = Number(rest[0]);
  if (!Number.isSafeInteger(number) || number < 1) return notFound();
  const pull = repo.pulls.get(number);
  if (pull === undefined) return notFound();
  if (rest.length === 1) {
    if (method === 'GET') return jsonResponse(200, pullObject(store, repo, pull));
    return error(405, 'Method Not Allowed');
  }
  if (rest.length === 2 && rest[1] === 'files') {
    if (method !== 'GET') return error(405, 'Method Not Allowed');
    const headTree = treeOfCommit(store, repo, pull.headSha);
    const baseTree = treeOfCommit(store, repo, pull.baseSha);
    return jsonResponse(200, diffTrees(store, repo, baseTree, headTree));
  }
  if (rest.length === 2 && rest[1] === 'merge') {
    if (method !== 'PUT') return error(405, 'Method Not Allowed');
    return mergePullRoute(store, repo, pull);
  }
  return notFound();
}

function createPullRoute(store: Store, repo: Repo, req: RestRequest): RestResponse {
  const body = asObject(req.body);
  const title = body ? asString(body.title) : null;
  const head = body ? asString(body.head) : null;
  const base = body ? asString(body.base) : null;
  if (title === null || title === '' || head === null || base === null) {
    return error(422, 'title, head and base are required');
  }
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === head) {
      return error(422, 'A pull request already exists for this head branch');
    }
  }
  const pull = createPull(store, repo, title, asString(body?.body) ?? '', head, base);
  if (pull === null) return error(422, 'head or base branch does not exist');
  return jsonResponse(201, pullObject(store, repo, pull));
}

function listPullsRoute(store: Store, repo: Repo, req: RestRequest): RestResponse {
  const state = req.query.get('state') ?? 'open';
  const pulls = [...repo.pulls.values()].filter((pull) => {
    if (state === 'all') return true;
    if (state === 'closed') return pull.state === 'closed';
    return pull.state === 'open';
  });
  return jsonResponse(200, pulls.map((pull) => pullObject(store, repo, pull)));
}

function mergePullRoute(store: Store, repo: Repo, pull: Pull): RestResponse {
  const result = mergePull(store, repo, pull);
  if (!result.ok) {
    if (result.reason === 'already closed') return error(405, 'Pull request is already closed');
    if (result.reason === 'conflict') return error(405, 'Merge conflict');
    return error(405, result.reason);
  }
  return jsonResponse(200, { merged: true, sha: result.sha, message: `Merge pull request #${pull.number} from ${pull.headRef}` });
}
