// Git smart-HTTP handlers: info/refs advertisements (v0 + v2), ls-refs,
// fetch (v2 and v0) and receive-pack v0.
//
// Wire facts (from the suite's client):
// - upload-pack info/refs answers v2 when the request carries
//   `Git-Protocol: version=2`, else v0. receive-pack is v0-only.
// - v2 advertisement: first data line is exactly `version 2`; capabilities
//   `fetch` and `ls-refs` must be present; `ls-refs` must NOT list `unborn`
//   (the client would then send the unborn arg and an empty repo would report
//   `unborn refs/heads/main`, failing clone-empty).
// - v0 advertisement: `# service=...` preamble, first ref line carries the
//   capabilities after NUL; empty repo uses `<zero-oid> capabilities^{}`.
//   v0 caps must include `symref=HEAD:refs/heads/main`.
// - ls-refs (v2): `HEAD` with `symref-target:refs/heads/main`, annotated tags
//   peel; ref-prefix filters server-side; with a prefix the HEAD line is NOT
//   returned; an empty repo returns no ref lines at all.
// - fetch v2 sections: acknowledgments / shallow-info / wanted-refs / packfile,
//   separated by delim/flush. The packfile section is OMITTED when nothing is
//   to be sent (an empty one throws in the client). Sideband band 1 = pack.
// - fetch v0: NAK/ACK + shallow/unshallow text lines, then sideband pack.
// - receive-pack: report-status inside sideband band 1, itself pkt-framed
//   (`unpack ok`, `ok <ref>` / `ng <ref> <reason>`); a non-fast-forward
//   refusal's reason is exactly `non-fast-forward`; a refused update still
//   unpacks (unpack ok) and the pack's objects are stored.

import {
  ZERO_OID,
  decodePktLines,
  encodePktLines,
  pktLine,
  readPack,
  sidebandPackets,
  type GitObject,
} from './gitobj.ts';
import { type Repo, type Store } from './store.ts';

const AGENT = 'github-core-clone/1.0.0';
const V2_CAPS = `version 2\nls-refs=ref-prefix\nfetch=shallow wait-for-done\nobject-format=sha1\nagent=${AGENT}\n`;
const V0_UPLOAD_CAPS = `symref=HEAD:refs/heads/main side-band-64k shallow thin-pack ofs-delta multi_ack_detailed agent=${AGENT}`;
const V0_RECEIVE_CAPS = `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT}`;

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function ok(contentType: string, body: Buffer): GitResponse {
  return { status: 200, contentType, body };
}

function notFound(): GitResponse {
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n') };
}

/** All refs of a repo, sorted: HEAD first (when included), then by name. */
function allRefs(store: Store, repo: Repo): { name: string; oid: string; peeled?: string }[] {
  const out: { name: string; oid: string; peeled?: string }[] = [];
  const mainTip = repo.git.refs.get('refs/heads/main');
  if (mainTip !== undefined) out.push({ name: 'HEAD', oid: mainTip });
  const names = [...repo.git.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.git.refs.get(name) as string;
    const entry: { name: string; oid: string; peeled?: string } = { name, oid };
    const object = repo.git.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const peeled = store.peelToCommit(repo, oid);
      if (peeled !== undefined) entry.peeled = peeled;
    }
    out.push(entry);
  }
  return out;
}

function v2Advertisement(): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), Buffer.from('0000', 'ascii')];
  for (const line of V2_CAPS.split('\n').filter(Boolean)) parts.push(pktLine(`${line}\n`));
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

function v0Advertisement(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? V0_UPLOAD_CAPS : V0_RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), Buffer.from('0000', 'ascii')];
  const refs = allRefs(store, repo).filter((ref) => ref.name !== 'HEAD');
  const mainTip = repo.git.refs.get('refs/heads/main');
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    // The first ref line carries the capabilities after NUL; HEAD first when it exists.
    if (mainTip !== undefined) parts.push(pktLine(`${mainTip} HEAD\0${caps}\n`));
    else parts.push(pktLine(`${refs[0]?.oid} ${refs[0]?.name}\0${caps}\n`));
    for (const ref of refs) {
      if (mainTip === undefined && ref === refs[0]) continue;
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string,
  gitProtocol: string | undefined,
): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  if (service === 'git-receive-pack') {
    return ok('application/x-git-receive-pack-advertisement', v0Advertisement(store, repo, 'git-receive-pack'));
  }
  if (service !== 'git-upload-pack') return notFound();
  if (gitProtocol === 'version=2') {
    return ok('application/x-git-upload-pack-advertisement', v2Advertisement());
  }
  return ok('application/x-git-upload-pack-advertisement', v0Advertisement(store, repo, 'git-upload-pack'));
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  prefixes: string[];
}

/** POST /{owner}/{repo}.git/git-upload-pack — ls-refs or fetch (v2 / v0). */
export function handleUploadPack(
  store: Store,
  owner: string,
  repoName: string,
  gitProtocol: string | undefined,
  body: Buffer,
): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'malformed pkt-line stream' }) + '\n') };
  }
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  if (lines.length === 0) {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'empty request' }) + '\n') };
  }
  const command = (lines[0] ?? '').trim();
  if (command === 'command=ls-refs') {
    return lsRefsResponse(store, repo, parseLsRefsArgs(lines));
  }
  if (command === 'command=fetch') {
    return fetchV2Response(store, repo, lines);
  }
  // v0 fetch: want/have/done lines in two flush-separated sections.
  if (command.startsWith('want ')) {
    return fetchV0Response(store, repo, lines);
  }
  return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: `unknown command ${JSON.stringify(command)}` }) + '\n') };
}

function parseLsRefsArgs(lines: readonly string[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, prefixes: [] };
  for (const line of lines.slice(1)) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') args.peel = true;
    else if (text === 'symrefs') args.symrefs = true;
    else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
  }
  return args;
}

function lsRefsResponse(store: Store, repo: Repo, args: LsRefsArgs): GitResponse {
  const refs = allRefs(store, repo);
  const lines: string[] = [];
  const mainTip = repo.git.refs.get('refs/heads/main');
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (mainTip !== undefined && keep('HEAD') && args.prefixes.length === 0) {
    lines.push(`${mainTip} HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
  }
  for (const ref of refs) {
    if (ref.name === 'HEAD') continue;
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  const parts = lines.map((line) => pktLine(line));
  parts.push(Buffer.from('0000', 'ascii'));
  return ok('application/x-git-upload-pack-result', Buffer.concat(parts));
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const line of lines.slice(1)) {
    const text = line.replace(/\n$/, '');
    // A v0 first want line carries the negotiated features after the oid.
    if (text.startsWith('want ')) args.wants.push(text.slice(5).trim().split(/\s+/)[0] as string);
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim().split(/\s+/)[0] as string);
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim().split(/\s+/)[0] as string);
    else if (text.startsWith('deepen ')) {
      const n = Number(text.slice(7).trim());
      if (Number.isFinite(n)) args.depth = n;
    }
  }
  return args;
}

function fetchV2Response(store: Store, repo: Repo, lines: readonly string[]): GitResponse {
  const args = parseFetchArgs(lines);
  const { pack, shallow, unshallow } = store.buildFetchPack(repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (args.haves.length > 0) {
    for (const have of args.haves) {
      if (repo.git.objects.has(have)) parts.push(pktLine(`ACK ${have}\n`));
    }
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(Buffer.from('0001', 'ascii'));
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  if (pack !== null) {
    parts.push(pktLine('packfile\n'));
    for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return ok('application/x-git-upload-pack-result', Buffer.concat(parts));
}

function fetchV0Response(store: Store, repo: Repo, lines: readonly string[]): GitResponse {
  const args = parseFetchArgs(lines);
  const { pack, shallow, unshallow } = store.buildFetchPack(repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  if (args.haves.length > 0) {
    for (const have of args.haves) {
      if (repo.git.objects.has(have)) parts.push(pktLine(`ACK ${have}\n`));
    }
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (pack !== null) {
    for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return ok('application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  const commands: PushCommand[] = [];
  let pack: Buffer | null = null;
  let unpackError: string | null = null;
  // Walk the pkt-line command list manually: the raw pack follows the first
  // flush and is NOT pkt-line framed, so a whole-buffer decode would choke.
  let offset = 0;
  let packStart = body.length;
  let malformed = false;
  while (offset + 4 <= body.length) {
    const len = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0 || len === 1) {
      malformed = true;
      break;
    }
    if (len === 0) {
      packStart = offset + 4;
      break;
    }
    if (len < 4 || offset + len > body.length) {
      malformed = true;
      break;
    }
    const text = body.subarray(offset + 4, offset + len).toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const head = nul >= 0 ? text.slice(0, nul) : text;
    const [oldOid, newOid, ref] = head.split(' ');
    if (oldOid !== undefined && newOid !== undefined && ref !== undefined) {
      commands.push({ oldOid, newOid, ref });
    }
    offset += len;
  }
  if (malformed || commands.length === 0) {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: malformed ? 'malformed pkt-line stream' : 'no push commands' }) + '\n') };
  }
  if (packStart < body.length) pack = body.subarray(packStart);
  // Unpack: store the pack's objects (hash-verified by readPack).
  if (pack !== null && pack.length > 0) {
    try {
      const read = readPack(pack);
      for (const [oid, object] of read.objects) repo.git.objects.set(oid, object);
      repo.packCache.clear();
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }
  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      const verdict = applyPushCommand(store, repo, command);
      if (verdict.ok) reportLines.push(`ok ${command.ref}\n`);
      else reportLines.push(`ng ${command.ref} ${verdict.reason}\n`);
    }
  }
  const report = encodePktLines(reportLines);
  const parts: Buffer[] = [...sidebandPackets(1, report), Buffer.from('0000', 'ascii')];
  return ok('application/x-git-receive-pack-result', Buffer.concat(parts));
}

function applyPushCommand(
  store: Store,
  repo: Repo,
  command: PushCommand,
): { ok: true } | { ok: false; reason: string } {
  const current = repo.git.refs.get(command.ref);
  if (command.newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return { ok: false, reason: 'remote ref does not exist' };
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
      return { ok: false, reason: 'non-fast-forward' };
    }
    repo.git.refs.delete(command.ref);
    repo.packCache.clear();
    return { ok: true };
  }
  if (command.oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return { ok: false, reason: 'already exists' };
    const object = repo.git.objects.get(command.newOid);
    if (object === undefined) return { ok: false, reason: 'object not found' };
    repo.git.refs.set(command.ref, command.newOid);
    repo.packCache.clear();
    return { ok: true };
  }
  // Update: old must match the current tip, and new must descend from old.
  if (current === undefined) return { ok: false, reason: 'remote ref does not exist' };
  if (command.oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
  const newCommit = store.peelToCommit(repo, command.newOid);
  if (newCommit === undefined) return { ok: false, reason: 'object not found' };
  if (!store.isAncestor(repo, command.oldOid, newCommit)) {
    return { ok: false, reason: 'non-fast-forward' };
  }
  repo.git.refs.set(command.ref, command.newOid);
  repo.packCache.clear();
  return { ok: true };
}
