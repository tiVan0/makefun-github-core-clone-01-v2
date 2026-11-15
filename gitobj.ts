// gitobj.ts — git objects, packs and the pkt-line framing, in the standard formats.
//
// Object identity is the SHA-1 of "<type> <size>\0" + content. Trees list their entries
// sorted git-style (a directory sorts as its name plus '/'); commits carry tree, parents,
// author and committer lines; tags carry object, type, tag and tagger lines. A pack is
// "PACK", version 2, a count, then per-object varint type/size headers with zlib-deflated
// bodies (plain objects and REF_DELTA / OFS_DELTA both), then a 20-byte SHA-1 trailer over
// everything before it. Pkt-lines are a 4-hex-digit length (the length itself included,
// 65520 bytes at most), 0000 for flush, 0001 for delim, 0002 for response-end.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);

/** The largest pkt-line, in bytes, length prefix included. */
export const PKT_LINE_MAX = 65520;

/** The identity the suite's own commits carry; our REST-built commits use the viewer. */
export const CONFORMANCE_IDENTITY = 'Conformance <conformance@make.fun>';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** The SHA-1 id of an object: sha1("<type> <size>\0" + data). */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function sha1Hex(data: Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

// -------------------------------------------------------------------------------------------
// trees, commits, tags
// -------------------------------------------------------------------------------------------

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Git's entry order: names compare with a directory's name carrying a trailing '/'. */
export function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  return an < bn ? -1 : an > bn ? 1 : 0;
}

/** Serialize tree entries: "<mode> <name>\0" + the 20 raw oid bytes, in git order. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree object into its entries. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('malformed tree: entry without a space');
    const mode = Buffer.from(data.subarray(offset, space)).toString('ascii');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('malformed tree: entry without a NUL + oid');
    const name = Buffer.from(data.subarray(space + 1, nul)).toString('utf8');
    const oid = Buffer.from(data.subarray(nul + 1, nul + 21)).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export function parseCommit(data: Uint8Array): CommitView {
  const text = Buffer.from(data).toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface BuildCommitFields {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
  readonly author: string;
  readonly committer: string;
  readonly timestamp: number;
}

export function buildCommit(fields: BuildCommitFields): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} +0000`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} +0000`);
  lines.push('');
  // The join leaves one trailing newline after the last header; the extra '\n' is the
  // blank line that separates the header block from the message.
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTag(data: Uint8Array): TagView {
  const text = Buffer.from(data).toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export interface BuildTagFields {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly message: string;
  readonly tagger: string;
  readonly timestamp: number;
}

export function buildTag(fields: BuildTagFields): Buffer {
  const lines = [
    `object ${fields.object}`,
    `type ${fields.type}`,
    `tag ${fields.tag}`,
    `tagger ${fields.tagger} ${fields.timestamp} +0000`,
    '',
  ];
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

// -------------------------------------------------------------------------------------------
// reachability
// -------------------------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

/**
 * Every object reachable from the roots: commits walk their trees and parents, tags walk
 * their target, trees walk their entries. Throws on a missing object.
 */
export function collectReachable(roots: Iterable<string>, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) throw new Error(`missing object ${oid}`);
    seen.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      queue.push(view.tree);
      for (const parent of view.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    }
  }
  return seen;
}

/** The commit generations from the roots: generation 0 is the roots themselves. */
export function commitGenerations(roots: readonly string[], lookup: ObjectLookup): Map<string, number> {
  const gen = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = roots.map((oid) => ({ oid, depth: 0 }));
  while (queue.length) {
    const { oid, depth } = queue.shift()!;
    if (gen.has(oid)) continue;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    gen.set(oid, depth);
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, depth: depth + 1 });
  }
  return gen;
}

// -------------------------------------------------------------------------------------------
// packs
// -------------------------------------------------------------------------------------------

export interface PackEntry {
  readonly oid: string;
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export interface PackReadResult {
  readonly version: number;
  readonly declaredCount: number;
  readonly objects: Map<string, GitObject>;
  readonly deltaCount: number;
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let next = size & 0x7f;
    size >>= 7;
    if (size > 0) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

/** Serialize objects as a pack (plain entries, no deltas): header, bodies, SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [Buffer.alloc(12)];
  parts[0].write('PACK', 0, 'ascii');
  parts[0].writeUInt32BE(2, 4);
  parts[0].writeUInt32BE(list.length, 8);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Verify a pack's trailer checksum. */
export function verifyPackChecksum(pack: Uint8Array): { ok: boolean; expected: string; actual: string } {
  if (pack.length < 32) return { ok: false, expected: '', actual: '' };
  const body = Buffer.from(pack.subarray(0, pack.length - 20));
  const expected = createHash('sha1').update(body).digest('hex');
  const actual = Buffer.from(pack.subarray(pack.length - 20)).toString('hex');
  return { ok: expected === actual, expected, actual };
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset];
    offset += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let baseOffset = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset];
    offset += 1;
    baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
  }
  return { baseOffset, next: offset };
}

/** Inflate one zlib stream starting at `offset`; returns the data and the next offset. */
export function inflateAt(buffer: Uint8Array, offset: number): { data: Buffer; next: number } {
  // Node's inflateSync ignores bytes after a stream's end and throws on a truncated
  // stream, so the stream's end is the smallest prefix that inflates cleanly.
  let low = offset + 1;
  let high = buffer.length;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    try {
      inflateSync(buffer.subarray(offset, mid));
      found = mid;
      high = mid - 1;
    } catch {
      low = mid + 1;
    }
  }
  if (found < 0) throw new Error('pack entry does not inflate');
  return { data: inflateSync(buffer.subarray(offset, found)), next: found };
}

/** Apply a git delta to its base, following the delta's copy/insert instructions. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          copyOffset |= delta[offset] << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          copySize |= delta[offset] << (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(Buffer.from(base.subarray(copyOffset, copyOffset + copySize)));
      produced += copySize;
    } else if (op > 0) {
      out.push(Buffer.from(delta.subarray(offset, offset + op)));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (produced !== targetSize) throw new Error('delta target size mismatch');
  return Buffer.concat(out);
}

/**
 * Parse a pack, resolving REF_DELTA and OFS_DELTA entries. `resolveBase` supplies objects
 * the pack refers to but does not carry (a thin pack's bases); without it a delta whose
 * base is outside the pack is an error.
 */
export function readPack(pack: Uint8Array, options: { resolveBase?: ObjectLookup } = {}): PackReadResult {
  const buffer = Buffer.from(pack);
  if (buffer.length < 32 || buffer.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a pack file');
  }
  const version = buffer.readUInt32BE(4);
  const declaredCount = buffer.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  const pending: Array<{ offset: number; type: GitObjectType; data: Buffer }> = [];
  let deltaCount = 0;
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const { size, next, first } = readVarintSize(buffer, offset);
    const typeCode = (first >> 4) & 0x07;
    offset = next;
    if (typeCode === 6 || typeCode === 7) {
      deltaCount += 1;
      let baseOid: string | null = null;
      let baseObject: GitObject | undefined;
      if (typeCode === 6) {
        const base = readOfsDeltaBase(buffer, offset);
        const baseOffset = entryOffset - base.baseOffset;
        offset = base.next;
        baseObject = byOffset.get(baseOffset);
        if (!baseObject) throw new Error('ofs-delta base is not an earlier pack entry');
      } else {
        baseOid = Buffer.from(buffer.subarray(offset, offset + 20)).toString('hex');
        offset += 20;
        baseObject = objects.get(baseOid) ?? options.resolveBase?.(baseOid);
        if (!baseObject) throw new Error(`ref-delta base ${baseOid} is not available`);
      }
      const inflated = inflateAt(buffer, offset);
      offset = inflated.next;
      const resolved = applyDelta(baseObject.data, inflated.data);
      const oid = hashObject(baseObject.type, resolved);
      const object: GitObject = { type: baseObject.type, data: resolved };
      objects.set(oid, object);
      byOffset.set(entryOffset, object);
      pending.push({ offset: entryOffset, type: object.type, data: resolved });
      void size;
      continue;
    }
    const type = CODE_TYPE[typeCode];
    if (!type) throw new Error(`unknown pack object type ${typeCode}`);
    const inflated = inflateAt(buffer, offset);
    offset = inflated.next;
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    const oid = hashObject(type, inflated.data);
    const object: GitObject = { type, data: inflated.data };
    objects.set(oid, object);
    byOffset.set(entryOffset, object);
    pending.push({ offset: entryOffset, type, data: inflated.data });
  }
  return { version, declaredCount, objects, deltaCount };
}

// -------------------------------------------------------------------------------------------
// pkt-lines
// -------------------------------------------------------------------------------------------

export type GitPacket =
  | { readonly kind: 'data'; readonly payload: Buffer; readonly raw: Buffer }
  | { readonly kind: 'flush'; readonly raw: Buffer }
  | { readonly kind: 'delim'; readonly raw: Buffer }
  | { readonly kind: 'response-end'; readonly raw: Buffer };

/** Frame one payload as a pkt-line (4-hex length, the length itself included). */
export function encodePktLine(payload: string | Uint8Array): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const total = body.length + 4;
  if (total > PKT_LINE_MAX) throw new Error(`pkt-line of ${total} bytes exceeds ${PKT_LINE_MAX}`);
  const head = Buffer.alloc(4);
  head.write(total.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktLineResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/** Frame a list of lines, flushes and delims into one buffer. */
export function encodePktLines(items: readonly (string | Uint8Array | 'flush' | 'delim' | 'response-end')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktLineFlush());
    else if (item === 'delim') parts.push(pktLineDelim());
    else if (item === 'response-end') parts.push(pktLineResponseEnd());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

/**
 * Decode a whole buffer of pkt-lines. Returns the packets and the offset where the framed
 * part ends (raw bytes follow, e.g. a pack after a receive-pack flush).
 */
export function decodePktLines(bytes: Uint8Array): { packets: GitPacket[]; endOffset: number } {
  const buffer = Buffer.from(bytes);
  const packets: GitPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', raw: buffer.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', raw: buffer.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', raw: buffer.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) break;
    packets.push({
      kind: 'data',
      payload: buffer.subarray(offset + 4, offset + length),
      raw: buffer.subarray(offset, offset + length),
    });
    offset += length;
  }
  return { packets, endOffset: offset };
}

/** True when the buffer starts with framed pkt-lines (a 4-hex length, or 0000/0001/0002). */
export function looksLikePktLines(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const head = Buffer.from(bytes.subarray(0, 4)).toString('ascii');
  if (!/^[0-9a-fA-F]{4}$/.test(head)) return false;
  const length = parseInt(head, 16);
  return length === 0 || length === 1 || length === 2 || (length >= 4 && length <= PKT_LINE_MAX);
}

/** Split a sideband-framed pack stream into band-1 bytes, ignoring progress and errors. */
export function sidebandPackData(packets: readonly GitPacket[]): Buffer {
  const chunks: Buffer[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data' || packet.payload.length < 1) continue;
    if (packet.payload[0] === 1) chunks.push(packet.payload.subarray(1));
  }
  return Buffer.concat(chunks);
}
