// store.ts — the forge's whole state, in memory.
//
// One Store holds every repository, its git objects and refs, its issues, pull requests,
// labels and comments. Lookups are flat maps; nothing scans. The store also owns the
// git-level operations the protocols share: tree editing, commit walking, merge-base,
// three-way squash merge, tree diffs, and fetch-pack construction with its cache.
//
// The store starts empty. The suite fills it through the API, and every grading run uses
// a fresh server, so nothing here is persisted to disk.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  commitGenerations,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  type GitObject,
  type TreeEntry,
} from './gitobj.ts';
import { DEFAULT_BRANCH, type ViewerUser } from './scenario.ts';

export interface IssueComment {
  readonly id: number;
  readonly body: string;
  readonly userLogin: string;
  readonly createdAt: string;
}

export interface Issue {
  readonly number: number;
  readonly id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly userLogin: string;
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: IssueComment[];
  /** The pre-serialised REST body; rebuilt only when the issue changes. */
  jsonCache: string | null;
}

export interface Pull {
  readonly number: number;
  readonly id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly headRef: string;
  readonly baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly userLogin: string;
  readonly createdAt: string;
  updatedAt: string;
}

export interface Label {
  readonly name: string;
  readonly color: string;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;
  readonly refs: Map<string, string>;
  readonly objects: Map<string, GitObject>;
  readonly labels: Map<string, Label>;
  readonly issues: Map<number, Issue>;
  issueCounter: number;
  readonly pulls: Map<number, Pull>;
  pullCounter: number;
  commentCounter: number;
  /** Bumped on any object or ref change; part of the fetch-pack cache key. */
  generation: number;
  readonly packCache: Map<string, { pack: Buffer; shallow: string[]; unshallow: string[] }>;
}

function isoNow(): string {
  return new Date().toISOString();
}

function epochNow(): number {
  return Math.floor(Date.now() / 1000);
}

export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export class Store {
  readonly viewer: ViewerUser;
  readonly repos = new Map<string, Repo>();
  private repoIdCounter = 5000;
  private issueIdCounter = 1;
  private pullIdCounter = 1;

  constructor(viewer: ViewerUser) {
    this.viewer = viewer;
  }

  /** The next global numeric id for an issue. */
  nextIssueId(): number {
    const id = this.issueIdCounter;
    this.issueIdCounter += 1;
    return id;
  }

  /** The next global numeric id for a pull request. */
  nextPullId(): number {
    const id = this.pullIdCounter;
    this.pullIdCounter += 1;
    return id;
  }

  // -----------------------------------------------------------------------------------------
  // repositories
  // -----------------------------------------------------------------------------------------

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(this.repoKey(owner, name))) return null;
    const repo: Repo = {
      id: this.repoIdCounter,
      owner,
      name,
      fullName: `${owner}/${name}`,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: isoNow(),
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: new Map(),
      issueCounter: 0,
      pulls: new Map(),
      pullCounter: 0,
      commentCounter: 0,
      generation: 0,
      packCache: new Map(),
    };
    this.repoIdCounter += 1;
    this.repos.set(repo.fullName, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    return out;
  }

  /** The viewer identity string for commits the server authors: "name <email>". */
  viewerIdentity(): string {
    return `${this.viewer.name} <${this.viewer.email}>`;
  }

  // -----------------------------------------------------------------------------------------
  // refs and objects
  // -----------------------------------------------------------------------------------------

  /** Resolve a ref name, a short branch name, or a raw oid to a commit oid. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (isObjectId(ref)) return repo.objects.has(ref) ? ref : null;
    if (repo.refs.has(ref)) return repo.refs.get(ref) ?? null;
    const headed = `refs/heads/${ref}`;
    if (repo.refs.has(headed)) return repo.refs.get(headed) ?? null;
    if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    return null;
  }

  refTip(repo: Repo, refName: string): string | null {
    return repo.refs.get(refName) ?? null;
  }

  /** Store objects (skipping ones already held); bumps the generation when anything is new. */
  putObjects(repo: Repo, objects: Iterable<GitObject>): void {
    let changed = false;
    for (const object of objects) {
      const oid = hashObject(object.type, object.data);
      if (!repo.objects.has(oid)) {
        repo.objects.set(oid, object);
        changed = true;
      }
    }
    if (changed) {
      repo.generation += 1;
      repo.packCache.clear();
    }
  }

  putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      repo.generation += 1;
      repo.packCache.clear();
    }
    return oid;
  }

  setRef(repo: Repo, refName: string, oid: string): void {
    repo.refs.set(refName, oid);
    repo.generation += 1;
    repo.packCache.clear();
  }

  deleteRef(repo: Repo, refName: string): boolean {
    const removed = repo.refs.delete(refName);
    if (removed) {
      repo.generation += 1;
      repo.packCache.clear();
    }
    return removed;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** True when `ancestor` is reachable from `descendant` through commit parents. */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>([descendant]);
    const queue = [descendant];
    while (queue.length) {
      const oid = queue.pop()!;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (parent === ancestor) return true;
        if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    }
    return false;
  }

  /** A merge base of two tips: the common ancestor closest to both (first-parent histories). */
  findMergeBase(repo: Repo, a: string, b: string): string | null {
    const generationsA = commitGenerations([a], (oid) => repo.objects.get(oid));
    const generationsB = commitGenerations([b], (oid) => repo.objects.get(oid));
    let best: string | null = null;
    let bestScore = -1;
    for (const [oid, genA] of generationsA) {
      const genB = generationsB.get(oid);
      if (genB === undefined) continue;
      const score = Math.min(genA, genB);
      if (score > bestScore) {
        bestScore = score;
        best = oid;
      }
    }
    return best;
  }

  /** First-parent walk from a tip, newest first. */
  listCommits(repo: Repo, tip: string): Array<{ sha: string; message: string; author: string; committer: string; timestamp: number; parents: string[] }> {
    const out: Array<{ sha: string; message: string; author: string; committer: string; timestamp: number; parents: string[] }> = [];
    const seen = new Set<string>();
    let current: string | null = tip;
    while (current && !seen.has(current)) {
      seen.add(current);
      const object = repo.objects.get(current);
      if (!object || object.type !== 'commit') break;
      const view = parseCommit(object.data);
      const stamp = Number((view.author.match(/ (\d+) \+0000$/) ?? [])[1] ?? 0);
      out.push({ sha: current, message: view.message, author: view.author, committer: view.committer, timestamp: stamp, parents: view.parents });
      current = view.parents[0] ?? null;
    }
    return out;
  }
}

// -----------------------------------------------------------------------------------------
// trees and file contents
// -----------------------------------------------------------------------------------------

/** The tree entries at a path inside a tree ('' is the root); null when the path is no tree. */
export function treeAtPath(store: Store, repo: Repo, rootTreeOid: string, path: string): TreeEntry[] | null {
  let current = rootTreeOid;
  if (path !== '') {
    for (const segment of path.split('/')) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
      if (!entry || entry.mode !== '40000') return null;
      current = entry.oid;
    }
  }
  const object = repo.objects.get(current);
  if (!object || object.type !== 'tree') return null;
  return parseTree(object.data);
}

/** The blob oid at a path inside a tree, or null when the path is not a file. */
export function blobAtPath(store: Store, repo: Repo, rootTreeOid: string, path: string): string | null {
  const segments = path.split('/');
  let current = rootTreeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) return entry.mode === '40000' ? null : entry.oid;
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/**
 * A new tree with `path` set to `blobOid` (or removed when null), built on `baseTreeOid`
 * (null = an empty tree). Intermediate directories are created as needed, and every new
 * tree object is stored. Returns the new root tree oid.
 */
export function setPathInTree(store: Store, repo: Repo, baseTreeOid: string | null, path: string, blobOid: string | null): string {
  const segments = path.split('/').filter((segment) => segment !== '');
  const build = (treeOid: string | null, depth: number): string => {
    const entries = new Map<string, TreeEntry>();
    if (treeOid) {
      const object = repo.objects.get(treeOid);
      if (object && object.type === 'tree') {
        for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
      }
    }
    const segment = segments[depth];
    if (depth === segments.length - 1) {
      if (blobOid === null) entries.delete(segment);
      else entries.set(segment, { mode: '100644', name: segment, oid: blobOid });
    } else {
      const child = entries.get(segment);
      const childOid = child && child.mode === '40000' ? child.oid : null;
      const next = build(childOid, depth + 1);
      const empty = store.putObject(repo, 'tree', buildTree([]));
      if (next === empty && !child) {
        // A deletion emptied this directory: drop it.
        entries.delete(segment);
      } else {
        entries.set(segment, { mode: '40000', name: segment, oid: next });
      }
    }
    const data = buildTree([...entries.values()]);
    return store.putObject(repo, 'tree', data);
  };
  return build(baseTreeOid, 0);
}

/** Read a path at a commit: a file (blob bytes), a directory (its entries), or null. */
export function readPathAtCommit(
  store: Store,
  repo: Repo,
  commitOid: string,
  path: string,
): { kind: 'file'; oid: string; data: Buffer } | { kind: 'dir'; entries: TreeEntry[] } | null {
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return null;
  const rootTree = parseCommit(commit.data).tree;
  if (path === '') {
    const entries = treeAtPath(store, repo, rootTree, '');
    return entries ? { kind: 'dir', entries } : null;
  }
  const blobOid = blobAtPath(store, repo, rootTree, path);
  if (blobOid) {
    const blob = repo.objects.get(blobOid);
    if (!blob || blob.type !== 'blob') return null;
    return { kind: 'file', oid: blobOid, data: blob.data };
  }
  const entries = treeAtPath(store, repo, rootTree, path);
  if (entries) return { kind: 'dir', entries };
  return null;
}

/** Flatten a tree into path -> blob oid, for diffs. */
export function flattenTree(store: Store, repo: Repo, rootTreeOid: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (treeOid: string, prefix: string): void => {
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, entry.oid);
    }
  };
  walk(rootTreeOid, '');
  return out;
}

export interface FileChange {
  readonly filename: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) count += 1;
  if (data[data.length - 1] !== 0x0a) count += 1;
  return count;
}

function countChangedLines(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const oldLines = new Set(oldData.toString('utf8').split('\n'));
  const newLines = newData.toString('utf8').split('\n');
  let additions = 0;
  for (const line of newLines) if (!oldLines.has(line)) additions += 1;
  const newSet = new Set(newLines);
  let deletions = 0;
  for (const line of oldData.toString('utf8').split('\n')) if (!newSet.has(line)) deletions += 1;
  return { additions, deletions };
}

/** The file-level diff between two trees, in path order. */
export function diffTrees(store: Store, repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): FileChange[] {
  const base = baseTreeOid ? flattenTree(store, repo, baseTreeOid) : new Map<string, string>();
  const head = headTreeOid ? flattenTree(store, repo, headTreeOid) : new Map<string, string>();
  const paths = [...new Set([...base.keys(), ...head.keys()])].sort();
  const out: FileChange[] = [];
  for (const path of paths) {
    const baseOid = base.get(path);
    const headOid = head.get(path);
    if (baseOid === headOid) continue;
    if (baseOid === undefined && headOid !== undefined) {
      const blob = repo.objects.get(headOid);
      const additions = blob ? countLines(blob.data) : 0;
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (headOid === undefined && baseOid !== undefined) {
      const blob = repo.objects.get(baseOid);
      const deletions = blob ? countLines(blob.data) : 0;
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (baseOid !== undefined && headOid !== undefined) {
      const oldBlob = repo.objects.get(baseOid);
      const newBlob = repo.objects.get(headOid);
      const { additions, deletions } = countChangedLines(oldBlob?.data ?? Buffer.alloc(0), newBlob?.data ?? Buffer.alloc(0));
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

/** The tree oid of a commit, or null. */
export function treeOfCommit(store: Store, repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

// -----------------------------------------------------------------------------------------
// contents commits (REST PUT/DELETE /contents)
// -----------------------------------------------------------------------------------------

export interface ContentsCommitResult {
  readonly commitOid: string;
  readonly blobOid: string | null;
  readonly branch: string;
  readonly createdBranch: boolean;
}

/**
 * Commit one file change on a branch: create the branch from the default tip when it does
 * not exist yet, create the first commit when the repository is unborn. Returns null when
 * the branch cannot be resolved.
 */
export function commitFileChange(
  store: Store,
  repo: Repo,
  options: { branch?: string; path: string; content: Buffer | null; message: string },
): ContentsCommitResult | null {
  const branch = options.branch ?? repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  let tip = repo.refs.get(refName) ?? null;
  let createdBranch = false;
  if (tip === null && branch !== repo.defaultBranch) {
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    if (tip !== null) createdBranch = true;
  }
  const baseTree = tip ? treeOfCommit(store, repo, tip) : null;
  let blobOid: string | null = null;
  if (options.content !== null) blobOid = store.putObject(repo, 'blob', options.content);
  const newTree = setPathInTree(store, repo, baseTree, options.path, blobOid);
  const identity = store.viewerIdentity();
  const commitData = buildCommit({
    tree: newTree,
    parents: tip ? [tip] : [],
    // Store the message verbatim: the REST surface reads it back exactly as sent.
    message: options.message,
    author: identity,
    committer: identity,
    timestamp: Math.floor(Date.now() / 1000),
  });
  const commitOid = store.putObject(repo, 'commit', commitData);
  store.setRef(repo, refName, commitOid);
  return { commitOid, blobOid, branch, createdBranch };
}

// -----------------------------------------------------------------------------------------
// issues
// -----------------------------------------------------------------------------------------

export function createIssue(store: Store, repo: Repo, title: string, body: string, labels: string[]): Issue {
  repo.issueCounter += 1;
  const now = isoNow();
  const issue: Issue = {
    number: repo.issueCounter,
    id: store.nextIssueId(),
    title,
    body,
    state: 'open',
    labels: [...labels],
    userLogin: store.viewer.login,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    comments: [],
    jsonCache: null,
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

export function listIssues(repo: Repo, state: string): Issue[] {
  const all = [...repo.issues.values()];
  if (state === 'all') return all;
  if (state === 'closed') return all.filter((issue) => issue.state === 'closed');
  return all.filter((issue) => issue.state === 'open');
}

// -----------------------------------------------------------------------------------------
// pull requests and merges
// -----------------------------------------------------------------------------------------

export function createPull(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  headRef: string,
  baseRef: string,
): Pull | null {
  const headSha = repo.refs.get(`refs/heads/${headRef}`) ?? null;
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`) ?? null;
  if (headSha === null || baseSha === null) return null;
  repo.pullCounter += 1;
  const now = isoNow();
  const pull: Pull = {
    number: repo.pullCounter,
    id: store.nextPullId(),
    title,
    body,
    state: 'open',
    headRef,
    baseRef,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    userLogin: store.viewer.login,
    createdAt: now,
    updatedAt: now,
  };
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** The three-way squash merge of a pull request, or a conflict report. */
export function mergePull(
  store: Store,
  repo: Repo,
  pull: Pull,
): { ok: true; sha: string } | { ok: false; reason: string } {
  if (pull.state !== 'open') return { ok: false, reason: 'already closed' };
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!headTip || !baseTip) return { ok: false, reason: 'missing branch' };
  const mergeBase = store.findMergeBase(repo, headTip, baseTip);
  if (mergeBase === null) return { ok: false, reason: 'no merge base' };
  const baseTree = treeOfCommit(store, repo, mergeBase);
  const headTree = treeOfCommit(store, repo, headTip);
  const baseTipTree = treeOfCommit(store, repo, baseTip);
  if (baseTree === null || headTree === null || baseTipTree === null) {
    return { ok: false, reason: 'missing tree' };
  }
  const headChanges = diffTrees(store, repo, baseTree, headTree);
  const baseChanges = diffTrees(store, repo, baseTree, baseTipTree);
  const baseChanged = new Map(baseChanges.map((change) => [change.filename, change]));
  const headChanged = new Map(headChanges.map((change) => [change.filename, change]));
  const headFlat = flattenTree(store, repo, headTree);
  const baseTipFlat = flattenTree(store, repo, baseTipTree);
  const mergeBaseFlat = flattenTree(store, repo, baseTree);
  for (const [path, headChange] of headChanged) {
    const baseChange = baseChanged.get(path);
    if (!baseChange) continue;
    const headOid = headFlat.get(path) ?? null;
    const baseTipOid = baseTipFlat.get(path) ?? null;
    if (headOid !== baseTipOid) return { ok: false, reason: 'conflict' };
    void headChange;
    void mergeBaseFlat;
  }
  // Apply the head's changes onto the base tip's tree.
  let mergedTree = baseTipTree;
  for (const change of headChanges) {
    const oid = headFlat.get(change.filename) ?? null;
    mergedTree = setPathInTree(store, repo, mergedTree, change.filename, oid);
  }
  const identity = store.viewerIdentity();
  const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
  const commitData = buildCommit({
    tree: mergedTree,
    parents: [baseTip],
    message,
    author: identity,
    committer: identity,
    timestamp: Math.floor(Date.now() / 1000),
  });
  const mergeSha = store.putObject(repo, 'commit', commitData);
  store.setRef(repo, `refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = isoNow();
  pull.mergeCommitSha = mergeSha;
  pull.updatedAt = isoNow();
  return { ok: true, sha: mergeSha };
}

/** MERGEABLE when a three-way merge would apply cleanly, CONFLICTING otherwise. */
export function pullMergeable(store: Store, repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!headTip || !baseTip) return 'UNKNOWN';
  const mergeBase = store.findMergeBase(repo, headTip, baseTip);
  if (mergeBase === null) return 'UNKNOWN';
  const baseTree = treeOfCommit(store, repo, mergeBase);
  const headTree = treeOfCommit(store, repo, headTip);
  const baseTipTree = treeOfCommit(store, repo, baseTip);
  if (baseTree === null || headTree === null || baseTipTree === null) return 'UNKNOWN';
  const headChanges = diffTrees(store, repo, baseTree, headTree);
  const baseChanges = diffTrees(store, repo, baseTree, baseTipTree);
  const baseChanged = new Set(baseChanges.map((change) => change.filename));
  const headFlat = flattenTree(store, repo, headTree);
  const baseTipFlat = flattenTree(store, repo, baseTipTree);
  for (const change of headChanges) {
    if (!baseChanged.has(change.filename)) continue;
    if ((headFlat.get(change.filename) ?? null) !== (baseTipFlat.get(change.filename) ?? null)) {
      return 'CONFLICTING';
    }
  }
  return 'MERGEABLE';
}

// -----------------------------------------------------------------------------------------
// fetch packs
// -----------------------------------------------------------------------------------------

export interface FetchPlan {
  readonly pack: Buffer;
  readonly shallow: string[];
  readonly unshallow: string[];
}

/**
 * Build the pack for a fetch: objects reachable from the wants, minus objects the client
 * already holds, bounded by depth when given. Shallow boundaries are the included commits
 * at the depth edge; a client shallow boundary whose parents are all now held becomes
 * unshallow. Results are cached per repository generation and request shape.
 */
export function buildFetchPack(
  store: Store,
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  clientShallow: readonly string[],
): FetchPlan {
  const key = [
    repo.generation,
    [...wants].sort().join(','),
    [...haves].sort().join(','),
    depth === null ? '' : String(depth),
    [...clientShallow].sort().join(','),
  ].join('|');
  const cached = repo.packCache.get(key);
  if (cached) return cached;

  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // What the client already holds: full closures of non-shallow haves; for a shallow have,
  // only the commit itself plus its tree and blobs (its parents are still missing there).
  const shallowSet = new Set(clientShallow);
  const held = new Set<string>();
  for (const have of haves) {
    if (shallowSet.has(have)) {
      const object = repo.objects.get(have);
      if (!object || object.type !== 'commit') continue;
      held.add(have);
      const view = parseCommit(object.data);
      const addTree = (treeOid: string): void => {
        const tree = repo.objects.get(treeOid);
        if (!tree || tree.type !== 'tree') return;
        held.add(treeOid);
        for (const entry of parseTree(tree.data)) {
          if (entry.mode === '40000') addTree(entry.oid);
          else held.add(entry.oid);
        }
      };
      addTree(view.tree);
    } else {
      try {
        for (const oid of collectReachable([have], lookup)) held.add(oid);
      } catch {
        // A have the server never saw: the client holds something unknown; ignore it.
      }
    }
  }

  // Walk from the wants, carrying commit generations: a commit at generation >= depth
  // is not included (its tree and blobs stay behind too), and an included commit at
  // generation depth-1 is a shallow boundary. Tags include their target at generation 0.
  const included = new Set<string>();
  const shallowOut: string[] = [];
  const queue: Array<{ oid: string; gen: number }> = wants.map((oid) => ({ oid, gen: 0 }));
  while (queue.length) {
    const { oid, gen } = queue.pop()!;
    if (included.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    if (object.type === 'commit') {
      if (depth !== null && gen >= depth) continue;
      included.add(oid);
      if (depth !== null && gen === depth - 1) shallowOut.push(oid);
      const view = parseCommit(object.data);
      queue.push({ oid: view.tree, gen });
      for (const parent of view.parents) queue.push({ oid: parent, gen: gen + 1 });
    } else if (object.type === 'tag') {
      included.add(oid);
      queue.push({ oid: parseTag(object.data).object, gen: 0 });
    } else if (object.type === 'tree') {
      included.add(oid);
      for (const entry of parseTree(object.data)) queue.push({ oid: entry.oid, gen });
    } else {
      included.add(oid);
    }
  }
  const toSend = new Set<string>();
  for (const oid of included) if (!held.has(oid)) toSend.add(oid);
  // A commit at the depth edge whose parents are excluded stays shallow; a client shallow
  // boundary whose parents are all held-or-sent is unshallow now.
  const unshallowOut: string[] = [];
  const deliveredOrHeld = new Set<string>([...held, ...toSend]);
  for (const boundary of clientShallow) {
    const object = repo.objects.get(boundary);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.every((parent) => deliveredOrHeld.has(parent))) {
      unshallowOut.push(boundary);
    } else if (included.has(boundary) || held.has(boundary)) {
      if (!shallowOut.includes(boundary)) shallowOut.push(boundary);
    }
  }

  const objects: GitObject[] = [];
  for (const oid of toSend) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  const pack = writePack(objects);
  const plan: FetchPlan = { pack, shallow: shallowOut, unshallow: unshallowOut };
  repo.packCache.set(key, plan);
  return plan;
}

/** Import a pack's objects into a repository (receive-pack). */
export function importPack(repo: Repo, pack: Buffer): { ok: true; count: number } | { ok: false; reason: string } {
  let parsed;
  try {
    parsed = readPack(pack, { resolveBase: (oid) => repo.objects.get(oid) });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'bad pack' };
  }
  let count = 0;
  for (const [oid, object] of parsed.objects) {
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, object);
      count += 1;
    }
  }
  if (count > 0) {
    repo.generation += 1;
    repo.packCache.clear();
  }
  return { ok: true, count };
}
