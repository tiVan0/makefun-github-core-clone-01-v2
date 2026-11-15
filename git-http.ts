// git-http.ts — the git smart-HTTP surface: info/refs, upload-pack, receive-pack.
//
// Two protocol versions, chosen by the Git-Protocol request header on upload-pack:
// v2 answers a capability list and the ls-refs / fetch commands; v0 answers the classic
// ref advertisement with capabilities on the first line. Receive-pack is v0-only.
// Every pack the server sends is a plain (undeltad) pack with a verified trailer, framed
// in sideband band-1 packets of at most 65515 payload bytes. A refused push is reported
// per ref (`ng <ref> non-fast-forward`), never thrown as an HTTP error, and a malformed
// POST is answered 400 while the server stays healthy.

import {
  ZERO_OID,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  isObjectId,
  looksLikePktLines,
  parseTag,
  pktLineDelim,
  pktLineFlush,
  PKT_LINE_MAX,
  type GitObject,
} from './gitobj.ts';
import {
  buildFetchPack,
  importPack,
  type Repo,
  type Store,
} from './store.ts';

const AGENT = 'makefun-clone/1.0';

export type BytesResponder = (status: number, contentType: string, body: Buffer) => void;

interface RefLine {
  readonly oid: string;
  readonly name: string;
  readonly peeled?: string;
}

/** All refs of a repository, HEAD first, then heads and tags in name order. */
export function listRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (headTip) out.push({ oid: headTip, name: 'HEAD' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const line: RefLine = { oid, name };
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (repo.objects.has(target)) (line as { peeled?: string }).peeled = target;
    }
    out.push(line);
  }
  return out;
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const maxPayload = PKT_LINE_MAX - 5; // 4 length bytes + 1 band byte
  for (let offset = 0; offset < pack.length; offset += maxPayload) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + maxPayload));
    const framed = Buffer.concat([Buffer.from([1]), slice]);
    chunks.push(encodePktLine(framed));
  }
  if (chunks.length === 0) chunks.push(encodePktLine(Buffer.from([1])));
  return chunks;
}

/** GET /<owner>/<repo>.git/info/refs?service=<service> */
export function handleInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: 'git-upload-pack' | 'git-receive-pack',
  gitProtocol: string | undefined,
  respond: BytesResponder,
): void {
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    respond(404, 'application/json; charset=utf-8', Buffer.from('{"message":"Not Found"}\n', 'utf8'));
    return;
  }
  const wantsV2 = service === 'git-upload-pack' && (gitProtocol ?? '').includes('version=2');
  const refs = listRefs(repo);
  if (wantsV2) {
    const lines: Buffer[] = [encodePktLine('version 2\n')];
    for (const cap of ['ls-refs=unborn', 'fetch=shallow', 'object-format=sha1', `agent=${AGENT}`]) {
      lines.push(encodePktLine(`${cap}\n`));
    }
    lines.push(pktLineFlush());
    respond(200, 'application/x-git-upload-pack-advertisement', Buffer.concat(lines));
    return;
  }
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k shallow thin-pack ofs-delta agent=${AGENT}`
      : `report-status side-band-64k delete-refs symref=HEAD:refs/heads/${repo.defaultBranch} ofs-delta agent=${AGENT}`;
  const contentType =
    service === 'git-upload-pack'
      ? 'application/x-git-upload-pack-advertisement'
      : 'application/x-git-receive-pack-advertisement';
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), pktLineFlush()];
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(encodePktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      if (ref.peeled) parts.push(encodePktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(pktLineFlush());
  respond(200, contentType, Buffer.concat(parts));
}

// -------------------------------------------------------------------------------------------
// upload-pack
// -------------------------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

/** Parse an upload-pack request body into an ls-refs or fetch request. */
function parseUploadPack(body: Buffer): { kind: 'ls-refs'; peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] } | { kind: 'fetch'; request: FetchRequest } | { kind: 'v0-fetch'; request: FetchRequest } | null {
  if (!looksLikePktLines(body)) return null;
  const { packets } = decodePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  if (lines.length === 0) return null;
  const first = lines[0];
  if (first.startsWith('command=ls-refs')) {
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    for (const line of lines.slice(1)) {
      const text = line.replace(/\n$/, '');
      if (text === 'peel') peel = true;
      else if (text === 'symrefs') symrefs = true;
      else if (text === 'unborn') unborn = true;
      else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
    }
    return { kind: 'ls-refs', peel, symrefs, unborn, prefixes };
  }
  if (first.startsWith('command=fetch')) {
    const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
    for (const line of lines.slice(1)) {
      const text = line.replace(/\n$/, '');
      if (text.startsWith('want ')) request.wants.push(text.slice(5).trim());
      else if (text.startsWith('have ')) request.haves.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) request.shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) {
        const n = Number(text.slice(7).trim());
        if (Number.isSafeInteger(n) && n > 0) request.depth = n;
      }
    }
    return { kind: 'fetch', request };
  }
  // v0: wants (+ shallow/deepen), flush, then haves + done. The flush above already ended
  // the first section; re-scan all data packets for the second section too.
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  const allLines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') allLines.push(packet.payload.toString('utf8'));
  }
  for (const line of allLines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) request.wants.push(text.slice(5).split(' ')[0]);
    else if (text.startsWith('have ')) request.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) request.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number(text.slice(7).trim());
      if (Number.isSafeInteger(n) && n > 0) request.depth = n;
    }
  }
  if (request.wants.length === 0) return null;
  return { kind: 'v0-fetch', request };
}

/** POST /<owner>/<repo>.git/git-upload-pack */
export function handleUploadPack(store: Store, owner: string, repoName: string, body: Buffer, respond: BytesResponder): void {
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    respond(404, 'application/json; charset=utf-8', Buffer.from('{"message":"Not Found"}\n', 'utf8'));
    return;
  }
  const parsed = parseUploadPack(body);
  if (parsed === null) {
    respond(400, 'application/json; charset=utf-8', Buffer.from('{"message":"malformed pkt-line request"}\n', 'utf8'));
    return;
  }
  if (parsed.kind === 'ls-refs') {
    const refs = listRefs(repo);
    const keep = (name: string): boolean =>
      parsed.prefixes.length === 0 || parsed.prefixes.some((prefix) => name.startsWith(prefix));
    const lines: Buffer[] = [];
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    if (parsed.unborn && !headTip && keep('HEAD')) {
      lines.push(encodePktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (ref.name === 'HEAD' && parsed.symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
      if (ref.peeled && parsed.peel) line += ` peeled:${ref.peeled}`;
      lines.push(encodePktLine(`${line}\n`));
    }
    lines.push(pktLineFlush());
    respond(200, 'application/x-git-upload-pack-result', Buffer.concat(lines));
    return;
  }
  const { wants, haves, shallow, depth } = parsed.request;
  const plan = buildFetchPack(store, repo, wants, haves, depth, shallow);
  if (parsed.kind === 'fetch') {
    const parts: Buffer[] = [];
    parts.push(encodePktLine('acknowledgments\n'), encodePktLine('NAK\n'), pktLineDelim());
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktLineDelim());
    parts.push(encodePktLine('wanted-refs\n'));
    for (const want of wants) {
      for (const ref of refsOf(repo)) {
        if (ref.oid === want) parts.push(encodePktLine(`${want} ${ref.name}\n`));
      }
    }
    parts.push(pktLineDelim());
    parts.push(encodePktLine('packfile\n'));
    for (const chunk of sidebandPackets(plan.pack)) parts.push(chunk);
    parts.push(pktLineFlush());
    respond(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
    return;
  }
  // v0: plain NAK/ACK + shallow lines, then the sideband pack, then flush.
  const parts: Buffer[] = [encodePktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  for (const chunk of sidebandPackets(plan.pack)) parts.push(chunk);
  parts.push(pktLineFlush());
  respond(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function refsOf(repo: Repo): RefLine[] {
  return listRefs(repo);
}

// -------------------------------------------------------------------------------------------
// receive-pack
// -------------------------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/** POST /<owner>/<repo>.git/git-receive-pack */
export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer, respond: BytesResponder): void {
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    respond(404, 'application/json; charset=utf-8', Buffer.from('{"message":"Not Found"}\n', 'utf8'));
    return;
  }
  if (!looksLikePktLines(body)) {
    respond(400, 'application/json; charset=utf-8', Buffer.from('{"message":"malformed pkt-line request"}\n', 'utf8'));
    return;
  }
  const { packets, endOffset } = decodePktLines(body);
  const commands: PushCommand[] = [];
  let sideband = false;
  let sawFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      const caps = text.slice(nul + 1);
      if (caps.includes('side-band-64k')) sideband = true;
      text = text.slice(0, nul);
    }
    const line = text.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length < 3 || !isObjectId(parts[0]) || !isObjectId(parts[1])) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  const report = (unpack: string, results: Array<{ ref: string; ok: boolean; reason: string }>): void => {
    const lines: Buffer[] = [encodePktLine(`unpack ${unpack}\n`)];
    for (const result of results) {
      lines.push(
        result.ok
          ? encodePktLine(`ok ${result.ref}\n`)
          : encodePktLine(`ng ${result.ref} ${result.reason}\n`),
      );
    }
    lines.push(pktLineFlush());
    const stream = Buffer.concat(lines);
    if (sideband) {
      const wrapped = Buffer.concat([encodePktLine(Buffer.concat([Buffer.from([1]), stream])), pktLineFlush()]);
      respond(200, 'application/x-git-receive-pack-result', wrapped);
    } else {
      respond(200, 'application/x-git-receive-pack-result', stream);
    }
  };
  if (!sawFlush || commands.length === 0) {
    report('ok', []);
    return;
  }
  const packBytes = body.subarray(endOffset);
  if (packBytes.length > 0) {
    const imported = importPack(repo, Buffer.from(packBytes));
    if (!imported.ok) {
      report(imported.reason, []);
      return;
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (command.newOid === ZERO_OID) {
      if (current === ZERO_OID) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.delete(command.ref);
      repo.generation += 1;
      repo.packCache.clear();
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (!target) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (command.oldOid !== ZERO_OID) {
      const targetType = target.type;
      if (targetType === 'commit' && !store.isAncestor(repo, command.oldOid, command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (targetType !== 'commit' && command.oldOid !== command.newOid) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    store.setRef(repo, command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  report('ok', results);
}
