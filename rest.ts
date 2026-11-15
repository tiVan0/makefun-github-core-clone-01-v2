// REST v3 (`/api/v3`): repos, branches, commits, contents, git refs, labels,
// issues, comments, pull requests (squash merge + conflict detection).
//
// Rules honoured here (from checks-rest.ts):
// - every reply is application/json (never HTML) and carries a non-empty
//   X-GitHub-Request-Id (app.ts adds it to every response);
// - error bodies are JSON with a string `message`; 401 without a token,
//   404 (never 403) for a repo under another owner, 422 for an unknown label
//   or a duplicate open pull request, 409 for a stale contents sha, 405 for a
//   conflicted merge, 400 for a malformed JSON body;
// - issue numbers share one counter with pull requests, per repo;
// - GET /user/repos paginates with `Link: <url>; rel="next"` (per_page + page);
// - contents PUT on an unborn repo creates the root commit; PUT with a `branch`
//   that does not exist creates the branch from the default tip.

import {
  restIssueJson,
  restPullJson,
  restRepoJson,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface ApiResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** Pre-serialised JSON body: sent as-is, without another stringify. */
  rawBody?: string;
}

export interface RestRequest {
  method: string;
  /** Path segments after `/api/v3` (already URI-decoded per segment). */
  segments: string[];
  query: URLSearchParams;
  /** Parsed JSON body (null when none); `malformed` when the body is not JSON. */
  body: unknown;
  malformed: boolean;
  /** Request origin, e.g. `http://127.0.0.1:4123`, for pagination links. */
  origin: string;
}

const ok = (body: unknown, status = 200, headers?: Record<string, string>): ApiResult => ({ status, body, headers });
const err = (status: number, message: string): ApiResult => ({ status, body: { message } });

function repoOr404(store: Store, owner: string, name: string): Repo | ApiResult {
  if (owner !== store.viewerLogin) return err(404, 'Not Found');
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  return repo;
}

function isApiResult(value: Repo | ApiResult): value is ApiResult {
  return (value as ApiResult).status !== undefined && (value as ApiResult).body !== undefined;
}

function intParam(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function paginate<T>(items: readonly T[], query: URLSearchParams): { page: T[]; totalPages: number; pageNo: number; perPage: number } {
  const perPage = Math.min(100, Math.max(1, intParam(query, 'per_page', 30)));
  const pageNo = intParam(query, 'page', 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNo - 1) * perPage;
  return { page: items.slice(start, start + perPage), totalPages, pageNo, perPage };
}

function linkHeader(origin: string, path: string, query: URLSearchParams, pageNo: number, perPage: number, totalPages: number): string {
  const url = (page: number): string => {
    const next = new URLSearchParams(query);
    next.set('page', String(page));
    next.set('per_page', String(perPage));
    return `${origin}${path}?${next.toString()}`;
  };
  const parts: string[] = [];
  if (pageNo < totalPages) parts.push(`<${url(pageNo + 1)}>; rel="next"`);
  if (pageNo > 1) parts.push(`<${url(pageNo - 1)}>; rel="prev"`);
  parts.push(`<${url(1)}>; rel="first"`);
  parts.push(`<${url(totalPages)}>; rel="last"`);
  return parts.join(', ');
}

export function handleRest(store: Store, req: RestRequest): ApiResult {
  const [first, second, third, ...rest] = req.segments;
  const method = req.method;

  // The API root and meta.
  if ((first === undefined || first === '') && method === 'GET') {
    return ok(
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      200,
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  if (first === 'meta' && method === 'GET') {
    return ok({ installed_version: '1.0.0' });
  }
  if (first === 'user' && second === undefined && method === 'GET') {
    return ok({
      login: store.viewerLogin,
      id: store.viewerId,
      node_id: 'user',
      type: 'User',
      html_url: `/users/${store.viewerLogin}`,
      url: '/api/v3/user',
    });
  }

  // POST /user/repos — create a repository owned by the token's login.
  if (first === 'user' && second === 'repos' && method === 'POST') {
    if (req.malformed) return err(400, 'malformed JSON body');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '') return err(422, 'name is required');
    const created = store.createRepo(store.viewerLogin, name, body.private === true, typeof body.description === 'string' ? body.description : '');
    if (created === null) return err(422, 'a repository with this name already exists');
    return ok(restRepoJson(created), 201);
  }

  // GET /user/repos — the viewer's repositories, paginated.
  if (first === 'user' && second === 'repos' && method === 'GET') {
    const repos = store.listRepos(store.viewerLogin);
    const { page, totalPages, pageNo, perPage } = paginate(repos, req.query);
    const headers: Record<string, string> = {};
    if (totalPages > 1 || repos.length > 0) {
      headers.link = linkHeader(req.origin, '/api/v3/user/repos', req.query, pageNo, perPage, totalPages);
    }
    return ok(page.map((repo) => restRepoJson(repo)), 200, headers);
  }

  // /repos/{owner}/{name}/...
  if (first === 'repos' && second !== undefined && third !== undefined) {
    return handleRepoRoute(store, req, second, third, rest);
  }

  return err(404, 'Not Found');
}

function handleRepoRoute(store: Store, req: RestRequest, owner: string, name: string, rest: string[]): ApiResult {
  const method = req.method;
  const resolved = repoOr404(store, owner, name);
  if (isApiResult(resolved)) return resolved;
  const repo = resolved;
  const [sub, subId, subSub] = rest;

  // GET / PATCH / DELETE /repos/{o}/{r}
  if (sub === undefined) {
    if (method === 'GET') return ok(restRepoJson(repo));
    if (method === 'PATCH') {
      if (req.malformed) return err(400, 'malformed JSON body');
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      return ok(restRepoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, name);
      return { status: 204, body: null };
    }
    return err(404, 'Not Found');
  }

  // Git data: refs.
  if (sub === 'git' && subId === 'refs' && method === 'POST') {
    if (req.malformed) return err(400, 'malformed JSON body');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!ref.startsWith('refs/') || sha === '') return err(422, 'ref and sha are required');
    const existing = repo.git.refs.get(ref);
    if (existing !== undefined) {
      if (existing === sha) return ok({ ref, object: { sha } }, 201);
      return err(422, 'the ref already exists');
    }
    if (repo.git.objects.get(sha) === undefined) return err(422, 'the sha does not exist');
    store.setRef(repo, ref, sha);
    return ok({ ref, object: { sha } }, 201);
  }
  if (sub === 'git' && subId === 'refs' && method === 'GET' && rest[2] !== undefined) {
    const refName = `refs/${rest.slice(2).join('/')}`;
    const sha = repo.git.refs.get(refName);
    if (sha === undefined) return err(404, 'Not Found');
    return ok({ ref: refName, object: { sha } });
  }

  // Branches.
  if (sub === 'branches' && method === 'GET' && subId === undefined) {
    const list = [...repo.git.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .sort()
      .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.git.refs.get(ref) as string } }));
    return ok(list);
  }
  if (sub === 'branches' && method === 'GET' && subId !== undefined) {
    const sha = repo.git.refs.get(`refs/heads/${subId}`);
    if (sha === undefined) return err(404, 'Not Found');
    return ok({ name: subId, commit: { sha } });
  }

  // Commits.
  if (sub === 'commits' && method === 'GET') {
    const ref = req.query.get('sha');
    const tip = ref === null ? repo.git.refs.get(`refs/heads/${repo.defaultBranch}`) : store.resolveRef(repo, ref);
    if (tip === undefined) return ok([]);
    const list = store.commitChain(repo, tip).map((oid) => {
      const object = repo.git.objects.get(oid);
      const parsed = object !== undefined && object.type === 'commit' ? parseCommitText(object.data) : null;
      return {
        sha: oid,
        commit: {
          message: parsed?.message.replace(/\r?\n$/, '') ?? '',
          author: { name: store.viewerLogin, email: store.viewerEmail() },
          committer: { name: store.viewerLogin, email: store.viewerEmail() },
        },
      };
    });
    const { page } = paginate(list, req.query);
    return ok(page);
  }

  // Contents.
  if (sub === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'PUT') return putContents(store, req, repo, path);
    if (method === 'GET') return getContents(store, req, repo, path);
    if (method === 'DELETE') return deleteContents(store, req, repo, path);
    return err(404, 'Not Found');
  }

  // Labels.
  if (sub === 'labels' && method === 'POST') {
    if (req.malformed) return err(400, 'malformed JSON body');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const labelName = typeof body.name === 'string' ? body.name : '';
    if (labelName === '') return err(422, 'name is required');
    const color = typeof body.color === 'string' ? body.color : 'ededed';
    const existing = repo.labels.get(labelName);
    if (existing !== undefined) return ok({ name: existing.name, color: existing.color }, 201);
    repo.labels.set(labelName, { name: labelName, color });
    return ok({ name: labelName, color }, 201);
  }
  if (sub === 'labels' && method === 'GET') {
    return ok([...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
  }

  // Issues.
  if (sub === 'issues') {
    return handleIssues(store, req, repo, subId, subSub);
  }

  // Pull requests.
  if (sub === 'pulls') {
    return handlePulls(store, req, repo, subId, subSub);
  }

  return err(404, 'Not Found');
}

function parseCommitText(data: Buffer): { message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  return { message: split === -1 ? '' : text.slice(split + 2) };
}

function putContents(store: Store, req: RestRequest, repo: Repo, path: string): ApiResult {
  if (req.malformed) return err(400, 'malformed JSON body');
  const body = (req.body ?? {}) as Record<string, unknown>;
  const message = typeof body.message === 'string' ? body.message : 'update';
  const content = typeof body.content === 'string' ? body.content : '';
  const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(content.replace(/\s+/g, ''), 'base64');
  } catch {
    return err(422, 'content is not valid base64');
  }
  const result = store.putContent(repo, branch, path, bytes, message, sha);
  if (!result.ok) return err(result.status, result.message);
  return ok(
    {
      content: { name: path.split('/').pop() ?? path, path, sha: result.contentSha, size: bytes.length, encoding: 'base64', type: 'file' },
      commit: { sha: result.commitSha, message },
    },
    result.created ? 201 : 200,
  );
}

function getContents(store: Store, req: RestRequest, repo: Repo, path: string): ApiResult {
  const ref = req.query.get('ref') ?? undefined;
  const tip = ref === undefined ? repo.git.refs.get(`refs/heads/${repo.defaultBranch}`) : store.resolveRef(repo, ref);
  if (tip === undefined) return err(404, 'Not Found');
  const blobOid = store.blobAtPath(repo, tip, path);
  if (blobOid !== null) {
    const object = repo.git.objects.get(blobOid);
    const data = object !== undefined && object.type === 'blob' ? object.data : Buffer.alloc(0);
    return ok({
      type: 'file',
      encoding: 'base64',
      size: data.length,
      name: path.split('/').pop() ?? path,
      path,
      content: data.toString('base64'),
      sha: blobOid,
    });
  }
  const dir = store.dirAtPath(repo, tip, path);
  if (dir === null) return err(404, 'Not Found');
  return ok(
    dir.map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      size: entry.mode === '40000' ? 0 : (repo.git.objects.get(entry.oid)?.data.length ?? 0),
      name: entry.name,
      path: path === '' ? entry.name : `${path}/${entry.name}`,
      sha: entry.oid,
    })),
  );
}

function deleteContents(store: Store, req: RestRequest, repo: Repo, path: string): ApiResult {
  if (req.malformed) return err(400, 'malformed JSON body');
  const body = (req.body ?? {}) as Record<string, unknown>;
  const message = typeof body.message === 'string' ? body.message : 'delete';
  const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  const result = store.deleteContent(repo, branch, path, message, sha);
  if (!result.ok) return err(result.status, result.message);
  return ok({ commit: { sha: result.commitSha, message } });
}

function handleIssues(store: Store, req: RestRequest, repo: Repo, subId: string | undefined, subSub: string | undefined): ApiResult {
  const method = req.method;
  // POST /repos/{o}/{r}/issues
  if (subId === undefined && method === 'POST') {
    if (req.malformed) return err(400, 'malformed JSON body');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = typeof body.title === 'string' ? body.title : '';
    const issueBody = typeof body.body === 'string' ? body.body : '';
    const labels = Array.isArray(body.labels) ? (body.labels.filter((label): label is string => typeof label === 'string')) : [];
    const created = store.createIssue(repo, title, issueBody, labels);
    if ('error' in created) return err(422, created.error);
    return ok(restIssueJson(repo, created), 201);
  }
  // GET /repos/{o}/{r}/issues
  if (subId === undefined && method === 'GET') {
    const state = req.query.get('state') ?? 'open';
    const sort = req.query.get('sort') ?? 'created';
    const direction = req.query.get('direction') ?? 'desc';
    let list = [...repo.issues.values()];
    if (state === 'open') list = list.filter((issue) => issue.state === 'open');
    else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
    if (sort === 'created') {
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
    }
    const { page } = paginate(list, req.query);
    return ok(page.map((issue) => restIssueJson(repo, issue)));
  }
  const number = Number(subId);
  if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
  // Comments.
  if (subSub === 'comments') {
    if (method === 'POST') {
      if (req.malformed) return err(400, 'malformed JSON body');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const commentBody = typeof body.body === 'string' ? body.body : '';
      const comment = store.addComment(repo, number, commentBody);
      if (comment === null) return err(404, 'Not Found');
      return ok({ id: comment.id, body: comment.body, user: { login: repo.owner, id: 1000, type: 'User' }, created_at: comment.createdAt }, 201);
    }
    if (method === 'GET') {
      const list = repo.comments.get(number) ?? [];
      return ok(list.map((comment) => ({ id: comment.id, body: comment.body, user: { login: repo.owner, id: 1000, type: 'User' }, created_at: comment.createdAt })));
    }
    return err(404, 'Not Found');
  }
  if (subSub !== undefined) return err(404, 'Not Found');
  // GET / PATCH /repos/{o}/{r}/issues/{n}
  if (method === 'GET') {
    const issue = repo.issues.get(number);
    if (issue === undefined) return err(404, 'Not Found');
    // The read workload hits this endpoint thousands of times for the same
    // issue: serve the pre-serialised JSON instead of rebuilding it.
    return { status: 200, body: null, rawBody: store.issueJson(repo, issue) };
  }
  if (method === 'PATCH') {
    if (req.malformed) return err(400, 'malformed JSON body');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const labels = Array.isArray(body.labels) ? (body.labels.filter((label): label is string => typeof label === 'string')) : undefined;
    if (labels !== undefined) {
      for (const name of labels) if (!repo.labels.has(name)) return err(422, `label ${JSON.stringify(name)} does not exist`);
    }
    const patched = store.patchIssue(repo, number, {
      state: typeof body.state === 'string' ? body.state : undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
      body: typeof body.body === 'string' ? body.body : undefined,
      labels,
    });
    if (patched === null) return err(404, 'Not Found');
    return ok(restIssueJson(repo, patched));
  }
  return err(404, 'Not Found');
}

function handlePulls(store: Store, req: RestRequest, repo: Repo, subId: string | undefined, subSub: string | undefined): ApiResult {
  const method = req.method;
  // POST /repos/{o}/{r}/pulls
  if (subId === undefined && method === 'POST') {
    if (req.malformed) return err(400, 'malformed JSON body');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = typeof body.title === 'string' ? body.title : '';
    const pullBody = typeof body.body === 'string' ? body.body : '';
    const head = typeof body.head === 'string' ? body.head : '';
    const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
    const created = store.createPull(repo, title, pullBody, head, base);
    if ('error' in created) return err(422, created.error);
    return ok(restPullJson(repo, created), 201);
  }
  // GET /repos/{o}/{r}/pulls
  if (subId === undefined && method === 'GET') {
    const state = req.query.get('state') ?? 'open';
    let list = [...repo.pulls.values()];
    if (state === 'open') list = list.filter((pull) => pull.state === 'open');
    else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
    list.sort((a, b) => b.number - a.number);
    const { page } = paginate(list, req.query);
    return ok(page.map((pull) => restPullJson(repo, pull)));
  }
  const number = Number(subId);
  if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
  const pull: Pull | undefined = repo.pulls.get(number);
  // GET /repos/{o}/{r}/pulls/{n}/files
  if (subSub === 'files' && method === 'GET') {
    if (pull === undefined) return err(404, 'Not Found');
    return ok(store.pullFiles(repo, pull));
  }
  // PUT /repos/{o}/{r}/pulls/{n}/merge
  if (subSub === 'merge' && method === 'PUT') {
    if (pull === undefined) return err(404, 'Not Found');
    const merged = store.mergePullSquash(repo, pull);
    if (!merged.ok) return err(merged.status, merged.message);
    return ok({ merged: true, sha: merged.sha, message: `${pull.title} (#${pull.number})` });
  }
  if (subSub !== undefined) return err(404, 'Not Found');
  // GET /repos/{o}/{r}/pulls/{n}
  if (method === 'GET') {
    if (pull === undefined) return err(404, 'Not Found');
    return ok(restPullJson(repo, pull));
  }
  return err(404, 'Not Found');
}
