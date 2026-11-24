/**
 * Minimal ZIP reader/writer with no dependencies.
 * Deflate uses the platform CompressionStream("deflate-raw") (Node 20+, all current browsers)
 * and falls back to Store when it is unavailable.
 */

export interface ZipEntryInput {
  name: string;
  data: Uint8Array | string;
}

export interface ZipWriteOptions {
  /** Compress entries with deflate when the platform supports it (default true). */
  compress?: boolean;
  /** Fixed modification date, for reproducible output. */
  date?: Date;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let crcTable: Uint32Array | undefined;
function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

export function crc32(data: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function hasCompressionStreams(): boolean {
  return typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";
}

async function pipeThrough(data: Uint8Array, stream: TransformStream<Uint8Array, Uint8Array>): Promise<Uint8Array> {
  const out = new Blob([data as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return pipeThrough(data, new CompressionStream("deflate-raw") as unknown as TransformStream<Uint8Array, Uint8Array>);
}

export async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return pipeThrough(data, new DecompressionStream("deflate-raw") as unknown as TransformStream<Uint8Array, Uint8Array>);
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export async function writeZip(entries: ZipEntryInput[], options: ZipWriteOptions = {}): Promise<Uint8Array> {
  const compress = (options.compress ?? true) && hasCompressionStreams();
  const { time, date } = dosDateTime(options.date ?? new Date(2026, 0, 1));
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const raw = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    const crc = crc32(raw);
    let method = 0;
    let body = raw;
    if (compress && raw.length > 64) {
      const deflated = await deflateRaw(raw);
      if (deflated.length < raw.length) {
        method = 8;
        body = deflated;
      }
    }
    if (body.length >= 0xffffffff || raw.length >= 0xffffffff) throw new Error(`ZIP entry too large: ${entry.name}`);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);

    chunks.push(local, body);
    central.push(cd);
    offset += local.length + body.length;
  }

  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + cdSize + end.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of [...chunks, ...central, end]) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

export interface ZipArchive {
  names: string[];
  read(name: string): Promise<Uint8Array>;
  readText(name: string): Promise<string>;
  has(name: string): boolean;
}

/** Parse a ZIP archive held in memory. Supports Store and Deflate entries. */
export function readZip(bytes: Uint8Array): ZipArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a ZIP archive (end of central directory not found)");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const index = new Map<string, { method: number; compSize: number; size: number; localOffset: number }>();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("Corrupt ZIP central directory");
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    index.set(name, { method, compSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const read = async (name: string): Promise<Uint8Array> => {
    const e = index.get(name);
    if (!e) throw new Error(`ZIP entry not found: ${name}`);
    const lo = e.localOffset;
    const nameLen = view.getUint16(lo + 26, true);
    const extraLen = view.getUint16(lo + 28, true);
    const start = lo + 30 + nameLen + extraLen;
    const body = bytes.subarray(start, start + e.compSize);
    if (e.method === 0) return body.slice();
    if (e.method === 8) {
      if (!hasCompressionStreams()) throw new Error("Deflate is not available on this platform");
      return inflateRaw(body);
    }
    throw new Error(`Unsupported ZIP compression method ${e.method} for ${name}`);
  };
  return {
    names: [...index.keys()],
    has: (name) => index.has(name),
    read,
    readText: async (name) => decoder.decode(await read(name)),
  };
}
