// 把插件目录打成一个 .fxplug（zip，STORE 无压缩，确定性构建）。
// 零依赖：手写最小 ZIP writer（CRC32 + 固定时间戳 + 条目按路径排序），
// 同一内容重复打包得到字节一致的产物。
//
// 用法：node scripts/pack.mjs
// 产物：dist/hf-accel-<version>.fxplug + dist/hf-accel-<version>.fxplug.sha256
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const dist = join(root, "dist");

// 固定 DOS 时间戳（2026-01-01 00:00:00 UTC），保证确定性。
const FIXED = (() => {
  const d = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
})();

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

// 收集待打包文件：排除 dist/、scripts/、点开头文件与目录、node_modules。
function walk(dir, prefix = "") {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === "dist" || name === "scripts" || name === "node_modules" || name.startsWith(".")) {
      continue;
    }
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) {
      out.push(...walk(full, rel));
    } else {
      out.push({ path: rel, full });
    }
  }
  return out;
}

function buildZip(entries) {
  const parts = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.path, "utf8");
    const data = readFileSync(e.full);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // local file header 签名
    lh.writeUInt16LE(20, 4); // 版本
    lh.writeUInt16LE(0x800, 6); // UTF-8 文件名标志
    lh.writeUInt16LE(0, 8); // STORE 无压缩
    lh.writeUInt16LE(FIXED.time, 10);
    lh.writeUInt16LE(FIXED.date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    parts.push(lh, nameBuf, data);
    centrals.push({ nameBuf, crc, size: data.length, offset });
    offset += 30 + nameBuf.length + data.length;
  }
  const cdStart = offset;
  for (const c of centrals) {
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); // central directory 签名
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x800, 8);
    ch.writeUInt16LE(0, 10); // STORE
    ch.writeUInt16LE(FIXED.time, 12);
    ch.writeUInt16LE(FIXED.date, 14);
    ch.writeUInt32LE(c.crc, 16);
    ch.writeUInt32LE(c.size, 20);
    ch.writeUInt32LE(c.size, 24);
    ch.writeUInt16LE(c.nameBuf.length, 28);
    // 30..41：extra/comment/磁盘号/内部外部属性 全零
    ch.writeUInt32LE(c.offset, 42);
    parts.push(ch, c.nameBuf);
    offset += 46 + c.nameBuf.length;
  }
  const cdSize = offset - cdStart;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  parts.push(eocd);
  return Buffer.concat(parts);
}

const entries = walk(root);
mkdirSync(dist, { recursive: true });
const base = `${manifest.identity.split("@")[1] || "plugin"}-${manifest.version}`;
const outPath = join(dist, `${base}.fxplug`);
const zip = buildZip(entries);
writeFileSync(outPath, zip);
const hash = createHash("sha256").update(zip).digest("hex");
writeFileSync(join(dist, `${base}.fxplug.sha256`), `${hash}\n`);
console.log(`dist/${base}.fxplug  (${zip.length} bytes, ${entries.length} files)`);
console.log(`sha256: ${hash}`);
