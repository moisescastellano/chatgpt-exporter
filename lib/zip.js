import { Buffer } from "node:buffer";

// ── ZIP builder ──────────────────────────────────────────────────────

export function crc32(buf) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function buildZip(files) {
  const entries = [];
  let offset = 0;
  for (const file of files) {
    const pathBuf = Buffer.from(file.path, "utf8");
    const data    = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, "utf8");
    const crc     = crc32(data);
    const header  = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(pathBuf.length, 26);
    entries.push({ header, pathBuf, data, crc, offset });
    offset += 30 + pathBuf.length + data.length;
  }
  const cdParts = [];
  for (const e of entries) {
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(e.crc, 16); cd.writeUInt32LE(e.data.length, 20); cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(e.pathBuf.length, 28); cd.writeUInt32LE(e.offset, 42);
    cdParts.push(cd, e.pathBuf);
  }
  const cdBuf = Buffer.concat(cdParts);
  const eocd  = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  const parts = [];
  for (const e of entries) parts.push(e.header, e.pathBuf, e.data);
  parts.push(cdBuf, eocd);
  return Buffer.concat(parts);
}

