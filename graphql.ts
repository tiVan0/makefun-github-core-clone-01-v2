// graphql.ts — a small hand-written GraphQL parser and executor for the shapes the
// suite sends: queries and mutations, variables, aliases, inline fragments, and the
// __type introspection probe. No library: the grammar is tokenised and parsed with a
// recursive descent over the exact documents in the kit (viewer, repository, issue,
// pull request, node, and the five mutations), and anything outside the schema is
// answered with a 200 carrying a GraphQL error, as the protocol requires.

import {
  createIssue,
  createPull,
  diffTrees,
  globalId,
  mergePull,
  pullMergeable,
  treeOfCommit,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { invalidateIssue } from './rest.ts';

// -------------------------------------------------------------------------------------------
// tokenizer
// -------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' ) {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@|&='.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u' && j + 5 < source.length) {
            out += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL source`);
  }
  return tokens;
}

// -------------------------------------------------------------------------------------------
// parser
// -------------------------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  readonly alias: string | null;
  readonly name: string;
  readonly args: Array<{ name: string; value: ValueNode }>;
  readonly selectionSet: SelectionNode[] | null;
}

export type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragmentSpread'; name: string }
  | { kind: 'inlineFragment'; typeCondition: string | null; selectionSet: SelectionNode[] };

export interface OperationNode {
  readonly kind: 'query' | 'mutation';
  readonly name: string | null;
  readonly variables: Array<{ name: string; defaultValue: ValueNode | null }>;
  readonly selectionSet: SelectionNode[];
}

export interface DocumentNode {
  readonly operations: OperationNode[];
  readonly fragments: Map<string, SelectionNode[]>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected '${value}' in GraphQL document`);
    }
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.peek()) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({
          kind: 'query',
          name: null,
          variables: [],
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation') {
        let name: string | null = null;
        const next = this.peek();
        if (next?.kind === 'name') name = this.expectName();
        const variables = this.parseVariableDefinitions();
        operations.push({ kind: keyword, name, variables, selectionSet: this.parseSelectionSet() });
      } else if (keyword === 'fragment') {
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('fragment needs "on Type"');
        this.expectName();
        fragments.set(name, this.parseSelectionSet());
      } else {
        throw new Error(`unsupported GraphQL definition '${keyword}'`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue: ValueNode | null }> {
    const out: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.expectPunct('(');
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        this.expectPunct('$');
        const name = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
          this.expectPunct('=');
          defaultValue = this.parseValue();
        }
        out.push({ name, defaultValue });
      }
      this.expectPunct(')');
    }
    return out;
  }

  private parseType(): void {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '[') {
      this.expectPunct('[');
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') this.expectPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek()!;
    if (token.kind === 'punct' && token.value === '...') {
      this.expectPunct('...');
      const next = this.peek()!;
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        return { kind: 'fragmentSpread', name: this.expectName() };
      }
      return { kind: 'inlineFragment', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    const name = this.expectName();
    let alias: string | null = null;
    let fieldName = name;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.expectPunct(':');
      alias = name;
      fieldName = this.expectName();
    }
    const args = this.parseArguments();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', field: { alias, name: fieldName, args, selectionSet } };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.expectPunct('(');
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const name = this.expectName();
        this.expectPunct(':');
        args.push({ name, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) {
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

export function parseGraphQL(source: string): DocumentNode {
  return new Parser(tokenize(source)).parseDocument();
}

// -------------------------------------------------------------------------------------------
// execution
// -------------------------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

interface GraphQLContext {
  readonly store: Store;
}

class GraphQLError extends Error {}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: JsonRecord = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): JsonRecord {
  const out: JsonRecord = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    return { kind: parts[0], parts: parts.slice(1) };
  } catch {
    return null;
  }
}

function findRepoById(store: Store, dbId: number): Repo | null {
  for (const repo of store.repos.values()) if (repo.id === dbId) return repo;
  return null;
}

const ISSUE_TYPE_FIELDS = [
  'id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt',
  'author', 'comments', 'labels', 'url', 'repository',
];
const PULL_REQUEST_TYPE_FIELDS = [
  'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
  'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'createdAt', 'updatedAt',
  'author', 'url', 'head', 'base',
];
const REPOSITORY_TYPE_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
  'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
  'pullRequest', 'description', 'createdAt', 'updatedAt', 'url', 'isPrivate', 'private',
];
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function cursorOf(offset: number): string {
  return Buffer.from(`cursor:${offset}`, 'utf8').toString('base64');
}

function offsetOf(cursor: string | null | undefined): number {
  if (typeof cursor !== 'string' || cursor === '') return 0;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return 0;
    const n = Number(text.slice('cursor:'.length));
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function viewerRecord(store: Store): JsonRecord {
  const viewer = store.viewer;
  return { __typename: 'User', login: viewer.login, id: viewer.id, name: viewer.name, email: viewer.email };
}

function repoRecord(store: Store, repo: Repo): JsonRecord {
  return {
    __typename: 'Repository',
    id: globalId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.fullName,
    description: repo.description,
    isPrivate: repo.isPrivate,
    _repo: repo,
  };
}

function issueRecord(store: Store, repo: Repo, issue: Issue): JsonRecord {
  return {
    __typename: 'Issue',
    id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issueState(issue),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    _repo: repo,
    _issue: issue,
  };
}

function pullRecord(store: Store, repo: Repo, pull: Pull): JsonRecord {
  return {
    __typename: 'PullRequest',
    id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pullState(pull),
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRefOid: pull.headSha,
    baseRefOid: pull.baseSha,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    _repo: repo,
    _pull: pull,
  };
}

function commentRecord(store: Store, repo: Repo, issue: Issue, comment: Issue['comments'][number]): JsonRecord {
  return {
    __typename: 'IssueComment',
    id: globalId('IssueComment', repo.id, issue.number, comment.id),
    body: comment.body,
    createdAt: comment.createdAt,
    _repo: repo,
    _issue: issue,
    _comment: comment,
  };
}

/** Resolve one field of a record; returns the raw value (record, array, scalar, null). */
function resolveField(ctx: GraphQLContext, parent: JsonRecord, field: FieldNode, args: JsonRecord): unknown {
  const store = ctx.store;
  const typename = parent.__typename as string;
  const name = field.name;
  const fail = (): never => {
    throw new GraphQLError(`Cannot query field "${name}" on type "${typename}".`);
  };

  if (typename === 'Query') {
    if (name === 'viewer') return viewerRecord(store);
    if (name === 'repository') {
      const owner = args.owner as string;
      const repoName = args.name as string;
      if (owner !== store.viewer.login) return null;
      const repo = store.getRepo(owner, repoName);
      return repo ? repoRecord(store, repo) : null;
    }
    if (name === 'node') {
      const decoded = typeof args.id === 'string' ? decodeGlobalId(args.id) : null;
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = findRepoById(store, Number(decoded.parts[0]));
        return repo ? repoRecord(store, repo) : null;
      }
      if (decoded.kind === 'Issue') {
        const repo = findRepoById(store, Number(decoded.parts[0]));
        const issue = repo?.issues.get(Number(decoded.parts[1]));
        return repo && issue ? issueRecord(store, repo, issue) : null;
      }
      if (decoded.kind === 'PullRequest') {
        const repo = findRepoById(store, Number(decoded.parts[0]));
        const pull = repo?.pulls.get(Number(decoded.parts[1]));
        return repo && pull ? pullRecord(store, repo, pull) : null;
      }
      if (decoded.kind === 'IssueComment') {
        const repo = findRepoById(store, Number(decoded.parts[0]));
        const issue = repo?.issues.get(Number(decoded.parts[1]));
        const comment = issue?.comments.find((c) => c.id === Number(decoded.parts[2]));
        return repo && issue && comment ? commentRecord(store, repo, issue, comment) : null;
      }
      return null;
    }
    if (name === '__type') {
      const typeName = args.name as string;
      if (typeName === 'Issue') {
        return { __typename: '__Type', name: 'Issue', kind: 'OBJECT', fields: ISSUE_TYPE_FIELDS, enumValues: [] };
      }
      if (typeName === 'PullRequest') {
        return { __typename: '__Type', name: 'PullRequest', kind: 'OBJECT', fields: PULL_REQUEST_TYPE_FIELDS, enumValues: [] };
      }
      if (typeName === 'Repository') {
        return { __typename: '__Type', name: 'Repository', kind: 'OBJECT', fields: REPOSITORY_TYPE_FIELDS, enumValues: [] };
      }
      if (typeName === 'SearchType') {
        return { __typename: '__Type', name: 'SearchType', kind: 'ENUM', fields: [], enumValues: SEARCH_TYPE_VALUES };
      }
      return null;
    }
    if (name === '__schema') {
      return { __typename: '__Schema', queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } };
    }
    return fail();
  }

  if (typename === 'Mutation') {
    if (name === 'createIssue') {
      const input = (args.input ?? {}) as JsonRecord;
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      const repo = decoded?.kind === 'Repository' ? findRepoById(store, Number(decoded.parts[0])) : null;
      if (!repo) throw new GraphQLError('createIssue: unknown repository');
      const issue = createIssue(store, repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return { __typename: 'CreateIssuePayload', issue: issueRecord(store, repo, issue) };
    }
    if (name === 'closeIssue') {
      const input = (args.input ?? {}) as JsonRecord;
      const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
      const repo = decoded?.kind === 'Issue' ? findRepoById(store, Number(decoded.parts[0])) : null;
      const issue = repo?.issues.get(Number(decoded?.parts[1] ?? NaN));
      if (!repo || !issue) throw new GraphQLError('closeIssue: unknown issue');
      issue.state = 'closed';
      issue.closedAt = new Date().toISOString();
      issue.updatedAt = issue.closedAt;
      invalidateIssue(issue);
      return { __typename: 'CloseIssuePayload', issue: issueRecord(store, repo, issue) };
    }
    if (name === 'createPullRequest') {
      const input = (args.input ?? {}) as JsonRecord;
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      const repo = decoded?.kind === 'Repository' ? findRepoById(store, Number(decoded.parts[0])) : null;
      if (!repo) throw new GraphQLError('createPullRequest: unknown repository');
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === headRef) {
          return { __typename: 'CreatePullRequestPayload', pullRequest: pullRecord(store, repo, existing) };
        }
      }
      const pull = createPull(store, repo, String(input.title ?? ''), String(input.body ?? ''), headRef, baseRef);
      if (!pull) throw new GraphQLError('createPullRequest: head or base branch does not exist');
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullRecord(store, repo, pull) };
    }
    if (name === 'mergePullRequest') {
      const input = (args.input ?? {}) as JsonRecord;
      const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
      const repo = decoded?.kind === 'PullRequest' ? findRepoById(store, Number(decoded.parts[0])) : null;
      const pull = repo?.pulls.get(Number(decoded?.parts[1] ?? NaN));
      if (!repo || !pull) throw new GraphQLError('mergePullRequest: unknown pull request');
      mergePull(store, repo, pull);
      return { __typename: 'MergePullRequestPayload', pullRequest: pullRecord(store, repo, pull) };
    }
    if (name === 'addComment') {
      const input = (args.input ?? {}) as JsonRecord;
      const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
      const repo = decoded?.kind === 'Issue' ? findRepoById(store, Number(decoded.parts[0])) : null;
      const issue = repo?.issues.get(Number(decoded?.parts[1] ?? NaN));
      if (!repo || !issue) throw new GraphQLError('addComment: unknown subject');
      repo.commentCounter += 1;
      const comment = {
        id: repo.commentCounter,
        body: String(input.body ?? ''),
        userLogin: store.viewer.login,
        createdAt: new Date().toISOString(),
      };
      issue.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node: commentRecord(store, repo, issue, comment) },
      };
    }
    return fail();
  }

  if (typename === 'User') {
    if (name === 'login' || name === 'name' || name === 'email') return parent[name] ?? null;
    if (name === 'id') return parent.id ?? null;
    return fail();
  }

  if (typename === 'Repository') {
    const repo = parent._repo as Repo;
    if (name === 'id') return parent.id;
    if (name === 'databaseId') return repo.id;
    if (name === 'name') return repo.name;
    if (name === 'nameWithOwner') return repo.fullName;
    if (name === 'description') return repo.description;
    if (name === 'isPrivate' || name === 'private') return repo.isPrivate;
    if (name === 'owner') return viewerRecord(store);
    if (name === 'defaultBranchRef') {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return tip ? { __typename: 'Ref', name: repo.defaultBranch } : null;
    }
    if (name === 'viewerPermission') return 'ADMIN';
    if (name === 'hasIssuesEnabled') return true;
    if (name === 'url') return `https://github.com/${repo.fullName}`;
    if (name === 'createdAt') return repo.createdAt;
    if (name === 'updatedAt') return repo.createdAt;
    if (name === 'issue') {
      const issue = repo.issues.get(Number(args.number));
      return issue ? issueRecord(store, repo, issue) : null;
    }
    if (name === 'issues') return issuesConnection(store, repo, args);
    if (name === 'pullRequest') {
      const pull = repo.pulls.get(Number(args.number));
      return pull ? pullRecord(store, repo, pull) : null;
    }
    if (name === 'pullRequests') return pullsConnection(store, repo, args);
    return fail();
  }

  if (typename === 'Ref') {
    if (name === 'name') return parent.name;
    return fail();
  }

  if (typename === 'Issue') {
    const issue = parent._issue as Issue;
    if (name === 'id') return parent.id;
    if (name === 'number') return issue.number;
    if (name === 'title') return issue.title;
    if (name === 'body') return issue.body;
    if (name === 'state') return issueState(issue);
    if (name === 'createdAt') return issue.createdAt;
    if (name === 'updatedAt') return issue.updatedAt;
    if (name === 'closedAt') return issue.closedAt;
    if (name === 'author') return viewerRecord(store);
    if (name === 'url') return `https://github.com/${(parent._repo as Repo).fullName}/issues/${issue.number}`;
    if (name === 'labels') return issue.labels.map((label) => ({ __typename: 'Label', name: label }));
    if (name === 'comments') {
      return {
        __typename: 'IssueCommentConnection',
        nodes: issue.comments.map((comment) => commentRecord(store, parent._repo as Repo, issue, comment)),
        totalCount: issue.comments.length,
      };
    }
    return fail();
  }

  if (typename === 'PullRequest') {
    const pull = parent._pull as Pull;
    const repo = parent._repo as Repo;
    if (name === 'id') return parent.id;
    if (name === 'number') return pull.number;
    if (name === 'title') return pull.title;
    if (name === 'body') return pull.body;
    if (name === 'state') return pullState(pull);
    if (name === 'merged') return pull.merged;
    if (name === 'mergeable') return pullMergeable(store, repo, pull);
    if (name === 'headRefName') return pull.headRef;
    if (name === 'baseRefName') return pull.baseRef;
    if (name === 'headRefOid') return pull.headSha;
    if (name === 'baseRefOid') return pull.baseSha;
    if (name === 'createdAt') return pull.createdAt;
    if (name === 'updatedAt') return pull.updatedAt;
    if (name === 'author') return viewerRecord(store);
    if (name === 'url') return `https://github.com/${repo.fullName}/pull/${pull.number}`;
    if (name === 'head') return { __typename: 'Ref', name: pull.headRef };
    if (name === 'base') return { __typename: 'Ref', name: pull.baseRef };
    if (name === 'files') {
      return pullFilesConnection(store, repo, pull, args);
    }
    return fail();
  }

  if (typename === 'IssueConnection' || typename === 'PullRequestConnection' || typename === 'PullRequestFileConnection' || typename === 'IssueCommentConnection') {
    if (name === 'nodes') return parent.nodes as unknown[];
    if (name === 'totalCount') return (parent.nodes as unknown[]).length;
    if (name === 'pageInfo') return parent.pageInfo as JsonRecord;
    if (name === 'edges') {
      return ((parent.nodes as JsonRecord[]) ?? []).map((node) => ({ __typename: 'Edge', node }));
    }
    return fail();
  }

  if (typename === 'PullRequestFile') {
    if (name === 'path') return parent.path;
    if (name === 'additions') return parent.additions ?? 0;
    if (name === 'deletions') return parent.deletions ?? 0;
    if (name === 'changes') return parent.changes ?? 0;
    return fail();
  }

  if (typename === 'IssueComment') {
    if (name === 'id') return parent.id;
    if (name === 'body') return parent.body;
    if (name === 'createdAt') return parent.createdAt;
    if (name === 'author') return viewerRecord(store);
    return fail();
  }

  if (typename === 'PageInfo') {
    if (name === 'hasNextPage') return parent.hasNextPage ?? false;
    if (name === 'hasPreviousPage') return parent.hasPreviousPage ?? false;
    if (name === 'endCursor') return parent.endCursor ?? null;
    if (name === 'startCursor') return parent.startCursor ?? null;
    return fail();
  }

  if (typename === '__Type') {
    if (name === 'name') return parent.name;
    if (name === 'kind') return parent.kind;
    if (name === 'fields') {
      return ((parent.fields as string[]) ?? []).map((fieldName) => ({ __typename: '__Field', name: fieldName }));
    }
    if (name === 'enumValues') {
      return ((parent.enumValues as string[]) ?? []).map((value) => ({ __typename: '__EnumValue', name: value }));
    }
    return fail();
  }

  if (typename === '__Field' || typename === '__EnumValue') {
    if (name === 'name') return parent.name;
    return fail();
  }

  if (typename === '__Schema') {
    if (name === 'queryType') return { __typename: '__Type', name: 'Query' };
    if (name === 'mutationType') return { __typename: '__Type', name: 'Mutation' };
    return fail();
  }

  if (typename === 'CreateIssuePayload' || typename === 'CloseIssuePayload') {
    if (name === 'issue') return parent.issue as JsonRecord;
    return fail();
  }
  if (typename === 'CreatePullRequestPayload' || typename === 'MergePullRequestPayload') {
    if (name === 'pullRequest') return parent.pullRequest as JsonRecord;
    return fail();
  }
  if (typename === 'AddCommentPayload') {
    if (name === 'commentEdge') return parent.commentEdge as JsonRecord;
    return fail();
  }
  if (typename === 'IssueCommentEdge' || typename === 'Edge') {
    if (name === 'node') return parent.node as JsonRecord;
    if (name === 'cursor') return parent.cursor ?? null;
    return fail();
  }
  if (typename === 'Label') {
    if (name === 'name') return parent.name;
    return fail();
  }

  return fail();
}

function issuesConnection(store: Store, repo: Repo, args: JsonRecord): JsonRecord {
  let issues = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = (args.orderBy ?? {}) as JsonRecord;
  const direction = String(orderBy.direction ?? 'ASC').toUpperCase();
  issues.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  const first = typeof args.first === 'number' ? args.first : 10;
  const offset = offsetOf(args.after as string | undefined);
  const nodes = issues.slice(offset, offset + first).map((issue) => issueRecord(store, repo, issue));
  return {
    __typename: 'IssueConnection',
    nodes,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: offset + nodes.length < issues.length,
      hasPreviousPage: offset > 0,
      endCursor: nodes.length > 0 ? cursorOf(offset + nodes.length) : null,
      startCursor: nodes.length > 0 ? cursorOf(offset) : null,
    },
  };
}

function pullsConnection(store: Store, repo: Repo, args: JsonRecord): JsonRecord {
  const pulls = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
  const first = typeof args.first === 'number' ? args.first : 10;
  const offset = offsetOf(args.after as string | undefined);
  const nodes = pulls.slice(offset, offset + first).map((pull) => pullRecord(store, repo, pull));
  return {
    __typename: 'PullRequestConnection',
    nodes,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: offset + nodes.length < pulls.length,
      hasPreviousPage: offset > 0,
      endCursor: nodes.length > 0 ? cursorOf(offset + nodes.length) : null,
      startCursor: nodes.length > 0 ? cursorOf(offset) : null,
    },
  };
}

function pullFilesConnection(store: Store, repo: Repo, pull: Pull, args: JsonRecord): JsonRecord {
  const headTree = treeOfCommit(store, repo, pull.headSha);
  const baseTree = treeOfCommit(store, repo, pull.baseSha);
  const changes = diffTrees(store, repo, baseTree, headTree);
  const first = typeof args.first === 'number' ? args.first : 10;
  const nodes = changes.slice(0, first).map((change) => ({
    __typename: 'PullRequestFile',
    path: change.filename,
    additions: change.additions,
    deletions: change.deletions,
    changes: change.changes,
  }));
  return { __typename: 'PullRequestFileConnection', nodes, pageInfo: { __typename: 'PageInfo', hasNextPage: changes.length > first, endCursor: null } };
}

// -------------------------------------------------------------------------------------------
// selection execution and the HTTP handler
// -------------------------------------------------------------------------------------------

function executeSelectionSet(
  ctx: GraphQLContext,
  parent: JsonRecord,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
  fragments: Map<string, SelectionNode[]>,
  errors: Array<{ message: string }>,
): JsonRecord {
  const out: JsonRecord = {};
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = fragments.get(selection.name);
      if (!fragment) {
        errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      Object.assign(out, executeSelectionSet(ctx, parent, fragment, variables, fragments, errors));
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition && selection.typeCondition !== (parent.__typename as string)) continue;
      Object.assign(out, executeSelectionSet(ctx, parent, selection.selectionSet, variables, fragments, errors));
      continue;
    }
    const field = selection.field;
    const responseKey = field.alias ?? field.name;
    let value: unknown;
    try {
      value = resolveField(ctx, parent, field, argsOf(field, variables));
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (field.selectionSet === null || value === null || value === undefined) {
      out[responseKey] = value ?? null;
      continue;
    }
    if (Array.isArray(value)) {
      out[responseKey] = value.map((item) =>
        item !== null && typeof item === 'object'
          ? executeSelectionSet(ctx, item as JsonRecord, field.selectionSet!, variables, fragments, errors)
          : item,
      );
      continue;
    }
    if (typeof value === 'object') {
      out[responseKey] = executeSelectionSet(ctx, value as JsonRecord, field.selectionSet, variables, fragments, errors);
      continue;
    }
    out[responseKey] = value;
  }
  return out;
}

export interface GraphQLResponse {
  readonly status: number;
  readonly body: string;
}

/** POST /api/graphql: one operation, or a batch (an array of operations). */
export function handleGraphQL(store: Store, body: unknown): GraphQLResponse {
  const ctx: GraphQLContext = { store };
  const runOne = (operation: unknown): JsonRecord => {
    if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) {
      return { errors: [{ message: 'GraphQL request must be an object with a query.' }] };
    }
    const query = (operation as { query?: unknown }).query;
    const variables = ((operation as { variables?: unknown }).variables ?? {}) as Record<string, unknown>;
    if (typeof query !== 'string' || query.trim() === '') {
      return { errors: [{ message: 'GraphQL request needs a query string.' }] };
    }
    let document: DocumentNode;
    try {
      document = parseGraphQL(query);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    const operationNode = document.operations[0];
    if (!operationNode) return { data: null, errors: [{ message: 'GraphQL document has no operation.' }] };
    const root: JsonRecord = { __typename: operationNode.kind === 'mutation' ? 'Mutation' : 'Query' };
    const errors: Array<{ message: string }> = [];
    const data = executeSelectionSet(ctx, root, operationNode.selectionSet, variables, document.fragments, errors);
    if (errors.length > 0) return { data, errors };
    return { data };
  };
  const result = Array.isArray(body) ? body.map(runOne) : runOne(body);
  return { status: 200, body: `${JSON.stringify(result)}\n` };
}
