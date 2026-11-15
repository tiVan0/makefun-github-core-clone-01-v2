// GraphQL v4 (`/api/graphql`) — a small parser + executor for the suite's
// fixed document set (the 18 documents checks-graphql.ts sends).
//
// Supported: query/mutation operations, named operations, variables, aliases,
// inline fragments (`... on Type { }`), arguments as variables, string/int
// literals, enums, input objects, lists, null and booleans; operation
// batching (a JSON array of operations in one body, answered in order).
// An unknown field is a 200 with an `errors` array naming the field (never
// an HTTP error). Global ids are opaque base64url tokens, stable across reads.

import {
  commentGlobalId,
  issueGlobalId,
  pullGlobalId,
  repoGlobalId,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ------------------------------------------------------------------ parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

interface FieldNode {
  alias: string | null;
  name: string;
  args: { name: string; value: Value }[];
  children: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragment'; typeCondition: string | null; children: SelectionNode[] };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selections: SelectionNode[];
}

class ParseError extends Error {}

class Parser {
  private readonly text: string;
  private pos = 0;

  constructor(text: string) {
    this.text = text;
  }

  parse(): Operation {
    this.skipIgnored();
    let type: 'query' | 'mutation' = 'query';
    if (this.peekWord() === 'mutation') {
      type = 'mutation';
      this.pos += 'mutation'.length;
    } else if (this.peekWord() === 'query') {
      this.pos += 'query'.length;
    }
    this.skipIgnored();
    let name: string | null = null;
    if (this.isNameStart(this.peek())) {
      name = this.readName();
      this.skipIgnored();
    }
    // Variable definitions: ($name: Type = default, ...).
    if (this.peek() === '(') this.skipBalanced('(', ')');
    this.skipIgnored();
    if (this.peek() !== '{') throw new ParseError('expected a selection set');
    const selections = this.readSelectionSet();
    return { type, name, selections };
  }

  private peek(): string {
    return this.text[this.pos] ?? '';
  }

  private peekWord(): string {
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.pos));
    return match === null ? '' : match[0];
  }

  private isNameStart(char: string): boolean {
    return /[A-Za-z_]/.test(char);
  }

  private skipIgnored(): void {
    for (;;) {
      const char = this.peek();
      if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',') {
        this.pos += 1;
      } else if (char === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
      } else {
        return;
      }
    }
  }

  private skipBalanced(open: string, close: string): void {
    let depth = 0;
    let inString = false;
    while (this.pos < this.text.length) {
      const char = this.text[this.pos] as string;
      if (inString) {
        if (char === '\\') this.pos += 1;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === open) depth += 1;
      else if (char === close) {
        depth -= 1;
        if (depth === 0) {
          this.pos += 1;
          return;
        }
      }
      this.pos += 1;
    }
  }

  private readName(): string {
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.pos));
    if (match === null) throw new ParseError('expected a name');
    this.pos += match[0].length;
    return match[0];
  }

  private readSelectionSet(): SelectionNode[] {
    this.expect('{');
    const nodes: SelectionNode[] = [];
    for (;;) {
      this.skipIgnored();
      if (this.peek() === '}') {
        this.pos += 1;
        return nodes;
      }
      if (this.pos >= this.text.length) throw new ParseError('unterminated selection set');
      if (this.text.startsWith('...', this.pos)) {
        this.pos += 3;
        this.skipIgnored();
        let typeCondition: string | null = null;
        if (this.peekWord() === 'on') {
          this.pos += 2;
          this.skipIgnored();
          typeCondition = this.readName();
          this.skipIgnored();
        }
        const children = this.readSelectionSet();
        nodes.push({ kind: 'fragment', typeCondition, children });
        continue;
      }
      const first = this.readName();
      this.skipIgnored();
      let alias: string | null = null;
      let name = first;
      if (this.peek() === ':') {
        this.pos += 1;
        this.skipIgnored();
        alias = first;
        name = this.readName();
        this.skipIgnored();
      }
      const args: { name: string; value: Value }[] = [];
      if (this.peek() === '(') {
        this.pos += 1;
        for (;;) {
          this.skipIgnored();
          if (this.peek() === ')') {
            this.pos += 1;
            break;
          }
          const argName = this.readName();
          this.skipIgnored();
          this.expect(':');
          this.skipIgnored();
          args.push({ name: argName, value: this.readValue() });
          this.skipIgnored();
        }
      }
      this.skipIgnored();
      const children = this.peek() === '{' ? this.readSelectionSet() : [];
      nodes.push({ kind: 'field', field: { alias, name, args, children } });
    }
  }

  private expect(char: string): void {
    if (this.peek() !== char) throw new ParseError(`expected ${char}`);
    this.pos += 1;
  }

  private readValue(): Value {
    const char = this.peek();
    if (char === '$') {
      this.pos += 1;
      return { kind: 'variable', name: this.readName() };
    }
    if (char === '"') return { kind: 'string', value: this.readString() };
    if (char === '[') {
      this.pos += 1;
      const items: Value[] = [];
      for (;;) {
        this.skipIgnored();
        if (this.peek() === ']') {
          this.pos += 1;
          return { kind: 'list', items };
        }
        items.push(this.readValue());
      }
    }
    if (char === '{') {
      this.pos += 1;
      const fields: { name: string; value: Value }[] = [];
      for (;;) {
        this.skipIgnored();
        if (this.peek() === '}') {
          this.pos += 1;
          return { kind: 'object', fields };
        }
        const name = this.readName();
        this.skipIgnored();
        this.expect(':');
        this.skipIgnored();
        fields.push({ name, value: this.readValue() });
      }
    }
    if (char === '-' || /[0-9]/.test(char)) {
      const match = /^-?\d+(\.\d+)?/.exec(this.text.slice(this.pos));
      if (match === null) throw new ParseError('bad number');
      this.pos += match[0].length;
      const num = Number(match[0]);
      return match[0].includes('.') ? { kind: 'float', value: num } : { kind: 'int', value: num };
    }
    const word = this.readName();
    if (word === 'true') return { kind: 'boolean', value: true };
    if (word === 'false') return { kind: 'boolean', value: false };
    if (word === 'null') return { kind: 'null' };
    return { kind: 'enum', value: word };
  }

  private readString(): string {
    this.expect('"');
    let out = '';
    while (this.pos < this.text.length) {
      const char = this.text[this.pos] as string;
      if (char === '"') {
        this.pos += 1;
        return out;
      }
      if (char === '\\') {
        const next = this.text[this.pos + 1] as string;
        if (next === 'n') out += '\n';
        else if (next === 't') out += '\t';
        else if (next === 'r') out += '\r';
        else out += next;
        this.pos += 2;
        continue;
      }
      out += char;
      this.pos += 1;
    }
    throw new ParseError('unterminated string');
  }
}

// ------------------------------------------------------------------ executor

type Variables = Record<string, unknown>;

function resolveValue(value: Value, variables: Variables): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, variables: Variables): unknown {
  const found = field.args.find((arg) => arg.name === name);
  return found === undefined ? undefined : resolveValue(found.value, variables);
}

const ISSUE_TYPE_FIELDS = ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'];
const PULL_TYPE_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'url', 'createdAt', 'updatedAt'];
const REPO_TYPE_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'private', 'defaultBranchRef', 'viewerPermission',
  'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt',
];
const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'RELEASE', 'LABEL'];

interface Executor {
  store: Store;
  errors: { message: string }[];
}

function selectFields(selections: SelectionNode[], typeName: string, object: unknown, ctx: Executor, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of selections) {
    if (node.kind === 'fragment') {
      if (node.typeCondition !== null && node.typeCondition !== typeName) continue;
      Object.assign(out, selectFields(node.children, typeName, object, ctx, variables));
      continue;
    }
    const field = node.field;
    const key = field.alias ?? field.name;
    out[key] = typeName.endsWith('Payload')
      ? resolvePayloadField(object, field, ctx, variables)
      : resolveField(typeName, object, field, ctx, variables);
  }
  return out;
}

function unknownField(ctx: Executor, fieldName: string, typeName: string): null {
  ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
  return null;
}

function resolveField(typeName: string, object: unknown, field: FieldNode, ctx: Executor, variables: Variables): unknown {
  const store = ctx.store;
  if (typeName === 'Query') return resolveQueryField(object, field, ctx, variables);
  if (typeName === 'Mutation') return resolveMutationField(object, field, ctx, variables);
  if (typeName === 'Repository') return resolveRepoField(object as Repo, field, ctx, variables);
  if (typeName === 'Issue') return resolveIssueField(object as IssueView, field, ctx, variables);
  if (typeName === 'PullRequest') return resolvePullField(object as PullView, field, ctx, variables);
  if (typeName === 'User') {
    if (field.name === 'login') return (object as { login: string }).login;
    return unknownField(ctx, field.name, typeName);
  }
  if (typeName === '__Type') return resolveTypeField(object as TypeView, field, ctx, variables);
  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection') {
    if (field.name === 'nodes') {
      const nodes = (object as { nodes: unknown[] }).nodes;
      return nodes.map((node) => {
        const kind = (object as { nodeKind: string }).nodeKind;
        return selectFields(field.children, kind, node, ctx, variables);
      });
    }
    if (field.name === 'pageInfo') {
      return selectFields(field.children, 'PageInfo', (object as { pageInfo: unknown }).pageInfo, ctx, variables);
    }
    return unknownField(ctx, field.name, typeName);
  }
  if (typeName === 'PageInfo') {
    const pageInfo = object as { hasNextPage: boolean; endCursor: string | null };
    if (field.name === 'hasNextPage') return pageInfo.hasNextPage;
    if (field.name === 'endCursor') return pageInfo.endCursor;
    return unknownField(ctx, field.name, typeName);
  }
  if (typeName === 'PullRequestChangedFile') {
    if (field.name === 'path') return (object as { path: string }).path;
    return unknownField(ctx, field.name, typeName);
  }
  if (typeName === 'Ref') {
    if (field.name === 'name') return (object as { name: string }).name;
    return unknownField(ctx, field.name, typeName);
  }
  if (typeName === 'CommentEdge') {
    if (field.name === 'node') return selectFields(field.children, 'Comment', (object as { node: unknown }).node, ctx, variables);
    return unknownField(ctx, field.name, typeName);
  }
  if (typeName === 'Comment') {
    const comment = object as { id: string; body: string };
    if (field.name === 'id') return comment.id;
    if (field.name === 'body') return comment.body;
    return unknownField(ctx, field.name, typeName);
  }
  return unknownField(ctx, field.name, typeName);
}

interface IssueView {
  repo: Repo;
  number: number;
  title: string;
  body: string;
  state: string;
}

interface PullView {
  repo: Repo;
  pull: Pull;
}

interface TypeView {
  name: string;
  fields: string[] | null;
  enumValues: string[] | null;
}

function resolveQueryField(_object: unknown, field: FieldNode, ctx: Executor, variables: Variables): unknown {
  const store = ctx.store;
  if (field.name === 'viewer') {
    return selectFields(field.children, 'User', { login: store.viewerLogin }, ctx, variables);
  }
  if (field.name === 'repository') {
    const owner = argValue(field, 'owner', variables) as string | undefined;
    const name = argValue(field, 'name', variables) as string | undefined;
    if (owner !== store.viewerLogin) return null;
    const repo = name === undefined ? undefined : store.getRepo(owner, name);
    if (repo === undefined) return null;
    return selectFields(field.children, 'Repository', repo, ctx, variables);
  }
  if (field.name === 'node') {
    const id = argValue(field, 'id', variables) as string | undefined;
    if (id === undefined) return null;
    const found = store.globalIds.get(id);
    if (found === undefined || found.kind !== 'repo') return null;
    const repo = store.repos.get(found.repoKey);
    if (repo === undefined) return null;
    return selectFields(field.children, 'Repository', repo, ctx, variables);
  }
  if (field.name === '__type') {
    const name = argValue(field, 'name', variables) as string | undefined;
    let view: TypeView | null = null;
    if (name === 'Issue') view = { name, fields: ISSUE_TYPE_FIELDS, enumValues: null };
    else if (name === 'PullRequest') view = { name, fields: PULL_TYPE_FIELDS, enumValues: null };
    else if (name === 'Repository') view = { name, fields: REPO_TYPE_FIELDS, enumValues: null };
    else if (name === 'SearchType') view = { name, fields: null, enumValues: SEARCH_TYPE_VALUES };
    if (view === null) return null;
    return selectFields(field.children, '__Type', view, ctx, variables);
  }
  return unknownField(ctx, field.name, 'Query');
}

function resolveTypeField(view: TypeView, field: FieldNode, ctx: Executor, _variables: Variables): unknown {
  if (field.name === 'name') return view.name;
  if (field.name === 'fields') {
    if (view.fields === null) return null;
    return view.fields.map((name) => ({ name }));
  }
  if (field.name === 'enumValues') {
    if (view.enumValues === null) return null;
    return view.enumValues.map((name) => ({ name }));
  }
  return unknownField(ctx, field.name, '__Type');
}

function issueView(repo: Repo, number: number): IssueView | null {
  const issue = repo.issues.get(number);
  if (issue === undefined) return null;
  return { repo, number, title: issue.title, body: issue.body, state: issue.state.toUpperCase() };
}

function resolveRepoField(repo: Repo, field: FieldNode, ctx: Executor, variables: Variables): unknown {
  const store = ctx.store;
  switch (field.name) {
    case 'id':
      return repoGlobalId(repo.owner, repo.name);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${repo.owner}/${repo.name}`;
    case 'owner':
      return selectFields(field.children, 'User', { login: repo.owner }, ctx, variables);
    case 'defaultBranchRef': {
      const tip = repo.git.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (tip === undefined) return null;
      return selectFields(field.children, 'Ref', { name: repo.defaultBranch }, ctx, variables);
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'issue': {
      const number = argValue(field, 'number', variables) as number | undefined;
      if (number === undefined) return null;
      const view = issueView(repo, number);
      if (view === null) return null;
      return selectFields(field.children, 'Issue', view, ctx, variables);
    }
    case 'issues': {
      const first = argValue(field, 'first', variables) as number | undefined;
      const states = argValue(field, 'states', variables) as unknown;
      const orderBy = argValue(field, 'orderBy', variables) as Record<string, unknown> | undefined;
      const after = argValue(field, 'after', variables) as string | null | undefined;
      let list = [...repo.issues.values()];
      if (Array.isArray(states)) {
        const wanted = new Set(states.map((state) => String(state).toLowerCase()));
        list = list.filter((issue) => wanted.has(issue.state));
      }
      const direction = orderBy !== undefined && orderBy.direction === 'ASC' ? 1 : -1;
      list.sort((a, b) => direction * (a.number - b.number));
      let afterNumber: number | null = null;
      if (typeof after === 'string' && after !== '') {
        try {
          const decoded = Buffer.from(after, 'base64url').toString('utf8');
          const match = /^cursor:(\d+)$/.exec(decoded);
          if (match !== null) afterNumber = Number(match[1]);
        } catch {
          afterNumber = null;
        }
      }
      if (afterNumber !== null) {
        list = direction === 1 ? list.filter((issue) => issue.number > afterNumber) : list.filter((issue) => issue.number < afterNumber);
      }
      const limit = first ?? list.length;
      const page = list.slice(0, limit);
      const hasNextPage = list.length > page.length;
      const last = page[page.length - 1];
      const endCursor = last === undefined ? null : Buffer.from(`cursor:${last.number}`, 'utf8').toString('base64url');
      return selectFields(field.children, 'IssueConnection', {
        nodes: page.map((issue) => issueView(repo, issue.number) as IssueView),
        nodeKind: 'Issue',
        pageInfo: { hasNextPage, endCursor },
      }, ctx, variables);
    }
    case 'pullRequests': {
      const first = argValue(field, 'first', variables) as number | undefined;
      const list = [...repo.pulls.values()].filter((pull) => pull.state === 'open').sort((a, b) => b.number - a.number);
      const page = first === undefined ? list : list.slice(0, first);
      return selectFields(field.children, 'PullRequestConnection', {
        nodes: page.map((pull) => ({ repo, pull }) as PullView),
        nodeKind: 'PullRequest',
        pageInfo: { hasNextPage: false, endCursor: null },
      }, ctx, variables);
    }
    case 'pullRequest': {
      const number = argValue(field, 'number', variables) as number | undefined;
      if (number === undefined) return null;
      const pull = repo.pulls.get(number);
      if (pull === undefined) return null;
      return selectFields(field.children, 'PullRequest', { repo, pull } as PullView, ctx, variables);
    }
    default:
      return unknownField(ctx, field.name, 'Repository');
  }
}

function resolveIssueField(view: IssueView, field: FieldNode, ctx: Executor, _variables: Variables): unknown {
  switch (field.name) {
    case 'id':
      return issueGlobalId(view.repo.owner, view.repo.name, view.number);
    case 'number':
      return view.number;
    case 'title':
      return view.title;
    case 'state':
      return view.state;
    case 'body':
      return view.body;
    default:
      return unknownField(ctx, field.name, 'Issue');
  }
}

function resolvePullField(view: PullView, field: FieldNode, ctx: Executor, variables: Variables): unknown {
  const { repo, pull } = view;
  switch (field.name) {
    case 'id':
      return pullGlobalId(repo.owner, repo.name, pull.number);
    case 'number':
      return pull.number;
    case 'state':
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    case 'merged':
      return pull.merged;
    case 'headRefName':
      return pull.head;
    case 'baseRefName':
      return pull.base;
    case 'mergeable':
      return ctx.store.mergeable(repo, pull);
    case 'files': {
      const first = argValue(field, 'first', variables) as number | undefined;
      const files = ctx.store.pullFiles(repo, pull);
      const page = first === undefined ? files : files.slice(0, first);
      return selectFields(field.children, 'PullRequestConnection', {
        nodes: page.map((file) => ({ path: file.filename })),
        nodeKind: 'PullRequestChangedFile',
        pageInfo: { hasNextPage: false, endCursor: null },
      }, ctx, variables);
    }
    default:
      return unknownField(ctx, field.name, 'PullRequest');
  }
}

function resolveMutationField(_object: unknown, field: FieldNode, ctx: Executor, variables: Variables): unknown {
  const store = ctx.store;
  const input = argValue(field, 'input', variables) as Record<string, unknown> | undefined;
  if (field.name === 'createIssue') {
    const repositoryId = input?.repositoryId as string | undefined;
    const title = input?.title as string | undefined;
    const body = (input?.body as string | undefined) ?? '';
    const found = repositoryId === undefined ? undefined : store.globalIds.get(repositoryId);
    if (found === undefined || found.kind !== 'repo') {
      ctx.errors.push({ message: 'createIssue: unknown repositoryId' });
      return null;
    }
    const repo = store.repos.get(found.repoKey);
    if (repo === undefined) {
      ctx.errors.push({ message: 'createIssue: unknown repositoryId' });
      return null;
    }
    const created = store.createIssue(repo, title ?? '', body, []);
    if ('error' in created) {
      ctx.errors.push({ message: `createIssue: ${created.error}` });
      return null;
    }
    return selectFields(field.children, 'CreateIssuePayload', { issue: issueView(repo, created.number) }, ctx, variables);
  }
  if (field.name === 'closeIssue') {
    const issueId = input?.issueId as string | undefined;
    const found = issueId === undefined ? undefined : store.globalIds.get(issueId);
    if (found === undefined || found.kind !== 'issue') {
      ctx.errors.push({ message: 'closeIssue: unknown issueId' });
      return null;
    }
    const repo = store.repos.get(found.repoKey);
    if (repo === undefined) {
      ctx.errors.push({ message: 'closeIssue: unknown issueId' });
      return null;
    }
    const patched = store.patchIssue(repo, found.number, { state: 'closed' });
    if (patched === null) {
      ctx.errors.push({ message: 'closeIssue: unknown issueId' });
      return null;
    }
    return selectFields(field.children, 'CloseIssuePayload', { issue: issueView(repo, found.number) }, ctx, variables);
  }
  if (field.name === 'createPullRequest') {
    const repositoryId = input?.repositoryId as string | undefined;
    const baseRefName = input?.baseRefName as string | undefined;
    const headRefName = input?.headRefName as string | undefined;
    const title = input?.title as string | undefined;
    const found = repositoryId === undefined ? undefined : store.globalIds.get(repositoryId);
    if (found === undefined || found.kind !== 'repo') {
      ctx.errors.push({ message: 'createPullRequest: unknown repositoryId' });
      return null;
    }
    const repo = store.repos.get(found.repoKey);
    if (repo === undefined) {
      ctx.errors.push({ message: 'createPullRequest: unknown repositoryId' });
      return null;
    }
    const created = store.createPull(repo, title ?? '', '', headRefName ?? '', baseRefName ?? repo.defaultBranch);
    if ('error' in created) {
      ctx.errors.push({ message: `createPullRequest: ${created.error}` });
      return null;
    }
    return selectFields(field.children, 'CreatePullRequestPayload', { pullRequest: { repo, pull: created } as PullView }, ctx, variables);
  }
  if (field.name === 'mergePullRequest') {
    const pullRequestId = input?.pullRequestId as string | undefined;
    const found = pullRequestId === undefined ? undefined : store.globalIds.get(pullRequestId);
    if (found === undefined || found.kind !== 'pull') {
      ctx.errors.push({ message: 'mergePullRequest: unknown pullRequestId' });
      return null;
    }
    const repo = store.repos.get(found.repoKey);
    const pull = repo?.pulls.get(found.number);
    if (repo === undefined || pull === undefined) {
      ctx.errors.push({ message: 'mergePullRequest: unknown pullRequestId' });
      return null;
    }
    const merged = store.mergePullSquash(repo, pull);
    if (!merged.ok) {
      ctx.errors.push({ message: `mergePullRequest: ${merged.message}` });
      return null;
    }
    return selectFields(field.children, 'MergePullRequestPayload', { pullRequest: { repo, pull } as PullView }, ctx, variables);
  }
  if (field.name === 'addComment') {
    const subjectId = input?.subjectId as string | undefined;
    const body = input?.body as string | undefined;
    const found = subjectId === undefined ? undefined : store.globalIds.get(subjectId);
    if (found === undefined || found.kind !== 'issue') {
      ctx.errors.push({ message: 'addComment: unknown subjectId' });
      return null;
    }
    const repo = store.repos.get(found.repoKey);
    if (repo === undefined) {
      ctx.errors.push({ message: 'addComment: unknown subjectId' });
      return null;
    }
    const comment = store.addComment(repo, found.number, body ?? '');
    if (comment === null) {
      ctx.errors.push({ message: 'addComment: unknown subjectId' });
      return null;
    }
    return selectFields(field.children, 'AddCommentPayload', {
      commentEdge: { node: { id: commentGlobalId(repo.owner, repo.name, found.number, comment.id), body: comment.body } },
    }, ctx, variables);
  }
  return unknownField(ctx, field.name, 'Mutation');
}

// Payload wrappers: `createIssue { issue { ... } }` etc.
function resolvePayloadField(object: unknown, field: FieldNode, ctx: Executor, variables: Variables): unknown {
  const record = object as Record<string, unknown>;
  if (field.name === 'issue' && record.issue !== undefined) {
    return selectFields(field.children, 'Issue', record.issue as IssueView, ctx, variables);
  }
  if (field.name === 'pullRequest' && record.pullRequest !== undefined) {
    return selectFields(field.children, 'PullRequest', record.pullRequest as PullView, ctx, variables);
  }
  if (field.name === 'commentEdge' && record.commentEdge !== undefined) {
    return selectFields(field.children, 'CommentEdge', record.commentEdge, ctx, variables);
  }
  return unknownField(ctx, field.name, 'Payload');
}

/** Execute one operation document. Returns the `{data, errors?}` envelope. */
export function executeGraphQL(
  store: Store,
  query: string,
  variables: Variables,
  operationName?: string,
): { data: Record<string, unknown> | null; errors?: { message: string }[] } {
  const ctx: Executor = { store, errors: [] };
  let operation: Operation;
  try {
    operation = new Parser(query).parse();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  void operationName;
  const data: Record<string, unknown> = {};
  for (const node of operation.selections) {
    if (node.kind === 'fragment') continue;
    const field = node.field;
    const key = field.alias ?? field.name;
    if (operation.type === 'mutation') {
      const value = resolveMutationField(null, field, ctx, variables);
      // Payload field selection happens inside the mutation resolver via the
      // payload wrappers; a null result stays null.
      data[key] = value;
    } else {
      data[key] = resolveQueryField(null, field, ctx, variables);
    }
  }
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

// The mutation resolvers above call selectFields with payload type names; those
// are routed to resolvePayloadField by selectFields itself.
