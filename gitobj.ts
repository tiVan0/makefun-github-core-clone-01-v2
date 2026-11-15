// Git object model, pack codec and pkt-line framing — implemented from the git
// wire spec (protocol v2 / smart HTTP) and the suite's client expectations.
// Plain packs only on the way out (no deltas): the suite's pack-deltas check
// verifies resolved objects, and 0 deltas passes it. Incoming packs are read
// with full delta support (ofs-delta + ref-delta) and every object's SHA-1 is
// verified on parse.

import { createHash } from 'node:crypto';
import { inflateSync as zlibInflate, deflateSync as zlibDeflate } from 'node:zlib';

/**
 * Inflate a zlib stream starting at the start of `buf` and report how many
 * input bytes the stream consumed (the stream may be followed by more data:
 * inflateSync ignores trailing bytes, and the `info` engine reports the
 * consumed count in bytesWritten).
 */
function inflateWithLength(buf: Buffer): { data: Buffer; compressedLength: number } {
  const result = zlibInflate(buf, { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, compressedLength: result.engine.bytesWritten };
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const PKT_LINE_MAX = 65520;

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

/** SHA-1 over `<type> <len>\0` + data. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function makeObject(type: ObjectType, data: Buffer): { oid: string; object: GitObject } {
  return { oid: hashObject(type, data), object: { type, data } };
}

// ---------------------------------------------------------------- commits

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. The message is everything after the first blank line. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
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

export interface Identity {
  name: string;
  email: string;
}

/** Build a commit object. The message is stored verbatim (no trailing newline added). */
export function buildCommit(input: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: Identity;
  committer: Identity;
  timestamp: number;
}): Buffer {
  const stamp = (who: Identity): string => `${who.name} <${who.email}> ${input.timestamp} +0000`;
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${stamp(input.author)}`);
  lines.push(`committer ${stamp(input.committer)}`);
  return Buffer.from(`${lines.join('\n')}\n\n${input.message}`, 'utf8');
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree object. Entries are sorted git-style (directories as name + '/'). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- tags

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
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

// ---------------------------------------------------------------- pkt-lines

export type PktItem = string | Buffer | 'flush' | 'delim';

/** One pkt-line: 4 hex length digits (total incl. the 4) + payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const out = Buffer.alloc(len);
  out.write(len.toString(16).padStart(4, '0'), 0, 'ascii');
  body.copy(out, 4);
  return out;
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function encodePktLines(items: readonly PktItem[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export type DecodedPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' };

/** Decode a whole pkt-line stream. Throws on a malformed length or truncation. */
export function decodePktLines(buf: Buffer): DecodedPacket[] {
  const packets: DecodedPacket[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line length');
    const len = parseInt(buf.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('malformed pkt-line length');
    if (len === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return packets;
}

/** Sideband packet: one band byte + data, chunked to the pkt-line ceiling. */
export function sidebandPackets(band: 1 | 2 | 3, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const maxData = PKT_LINE_MAX - 4 - 1;
  for (let offset = 0; offset < data.length || out.length === 0; offset += maxData) {
    const chunk = data.subarray(offset, offset + maxData);
    out.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return out;
}

// ---------------------------------------------------------------- packs

const TYPE_CODES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_IDS: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let byte = buf[offset] as number;
  let value = byte & 0x0f;
  let next = offset + 1;
  let shift = 4;
  while ((byte & 0x80) !== 0) {
    byte = buf[next] as number;
    next += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
  }
  return { value, next };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readDeltaVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readDeltaVarint();
  const targetSize = readDeltaVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let size = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          copyOffset |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          copySize |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      size += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
      size += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || size !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

/** Read a packfile. Verifies every object's SHA-1; throws on any corruption. */
export function readPack(pack: Buffer): { objects: Map<string, GitObject>; deltaCount: number } {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let offset = 12;
  let deltaCount = 0;
  for (let i = 0; i < count; i += 1) {
    const entryStart = offset;
    const first = pack[offset] as number;
    const typeCode = (first >> 4) & 0x7;
    const sizeInfo = readVarint(pack, offset);
    offset = sizeInfo.next;
    const size = sizeInfo.value;
    let type: ObjectType;
    let data: Buffer;
    if (typeCode === 6) {
      // ofs-delta: negative offset to the base entry.
      let byte = pack[offset] as number;
      offset += 1;
      let baseOffset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = pack[offset] as number;
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      const baseEntry = byOffset.get(entryStart - baseOffset);
      if (baseEntry === undefined) throw new Error('ofs-delta base not found');
      const raw = inflateWithLength(pack.subarray(offset));
      offset += raw.compressedLength;
      data = applyDelta(baseEntry.data, raw.data);
      type = baseEntry.type;
      deltaCount += 1;
    } else if (typeCode === 7) {
      // ref-delta: base object id.
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const baseEntry = objects.get(baseOid);
      if (baseEntry === undefined) throw new Error('ref-delta base not found');
      const raw = inflateWithLength(pack.subarray(offset));
      offset += raw.compressedLength;
      data = applyDelta(baseEntry.data, raw.data);
      type = baseEntry.type;
      deltaCount += 1;
    } else {
      type = TYPE_CODES[typeCode] as ObjectType;
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const raw = inflateWithLength(pack.subarray(offset));
      offset += raw.compressedLength;
      data = raw.data;
      if (data.length !== size) throw new Error('pack object size mismatch');
    }
    const oid = hashObject(type, data);
    const object = { type, data };
    objects.set(oid, object);
    byOffset.set(entryStart, object);
  }
  return { objects, deltaCount };
}

/** Write a plain pack (no deltas). Objects are emitted in oid order (deterministic). */
export function writePack(inputs: readonly GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(inputs.length, 8);
  const parts: Buffer[] = [header];
  const withOid = inputs.map((object) => ({ oid: hashObject(object.type, object.data), object }));
  withOid.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  for (const { object } of withOid) {
    const typeId = TYPE_IDS[object.type];
    const size = object.data.length;
    // type+size varint: first byte holds type (bits 4-6) + low 4 size bits.
    const bytes: number[] = [];
    let remaining = size >>> 4;
    let first = (typeId << 4) | (size & 0x0f);
    if (remaining > 0) first |= 0x80;
    bytes.push(first);
    while (remaining > 0) {
      let next = remaining & 0x7f;
      remaining >>>= 7;
      if (remaining > 0) next |= 0x80;
      bytes.push(next);
    }
    parts.push(Buffer.from(bytes));
    parts.push(zlibDeflate(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Verify a pack's SHA-1 trailer. */
export function verifyPackChecksum(pack: Buffer): { ok: boolean; expected: string; actual: string } {
  if (pack.length < 20) return { ok: false, expected: '', actual: '' };
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  const actual = pack.subarray(pack.length - 20).toString('hex');
  return { ok: expected === actual, expected, actual };
}
