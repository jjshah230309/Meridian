// Meridian ERP :: core/zip
// A minimal ZIP reader and writer, because .xlsx (and .docx, .pptx) are zip
// archives and this project carries no dependencies.
//
// Writes the classic (non-Zip64) format: a local header per entry, then a
// central directory, then the end-of-central-directory record. Entries are
// deflated with node:zlib unless storing raw is smaller, which happens often
// with the tiny XML parts an xlsx is made of.
//
// Reading walks the central directory rather than scanning local headers in
// order -- the central directory is the authoritative index of what is in
// the archive and where, which is exactly why every real zip tool reads it
// first too. A corrupt or truncated local header then shows up as "this one
// entry failed to inflate" rather than derailing every entry after it.
import zlib from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;

/** CRC-32, table built once on first use. */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** MS-DOS packed date and time, which is what the format stores. */
function dosDateTime(d = new Date()) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

/**
 * Build a zip archive.
 * `files` is [{ name, data }] where data is a Buffer or string.
 */
export function zip(files, { date = new Date() } = {}) {
  const { time: dosTime, date: dosDate } = dosDateTime(date);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    // Storing beats deflating for very small or incompressible parts.
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0, 6);             // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);            // extra length
    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(SIG_CENTRAL, 0);
    cd.writeUInt16LE(20, 4);               // version made by
    cd.writeUInt16LE(20, 6);               // version needed
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);               // extra
    cd.writeUInt16LE(0, 32);               // comment
    cd.writeUInt16LE(0, 34);               // disk number
    cd.writeUInt16LE(0, 36);               // internal attrs
    cd.writeUInt32LE(0, 38);               // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(0, 4);                 // this disk
  end.writeUInt16LE(0, 6);                 // disk with central dir
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);                // comment length

  return Buffer.concat([...chunks, centralBuf, end]);
}

// ======================================================================
// Reading
// ======================================================================

/** Byte signatures of formats people hand us that are not, in fact, a zip. */
const LOOKS_LIKE = [
  { bytes: [0xd0, 0xcf, 0x11, 0xe0], name: 'an older Excel file (.xls, the 97-2003 format)' },
  { bytes: [0x25, 0x50, 0x44, 0x46], name: 'a PDF' },
  { bytes: [0x3c, 0x3f, 0x78, 0x6d, 0x6c], name: 'a plain XML file (Excel 2003 "SpreadsheetML")' },
  { bytes: [0x3c, 0x68, 0x74, 0x6d], name: 'an HTML file (a spreadsheet program can save a web page with a .xls name)' },
];

class ZipFormatError extends Error {}

function identifyNonZip(buf) {
  for (const { bytes, name } of LOOKS_LIKE) {
    if (bytes.every((b, i) => buf[i] === b)) return name;
  }
  return null;
}

/**
 * Find the end-of-central-directory record.
 * It is normally the last 22 bytes, but a zip can carry a trailing comment
 * (up to 65,535 bytes), so this scans backward from the end rather than
 * assuming position zero from the tail.
 */
function findEnd(buf) {
  const minScan = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= minScan; i--) {
    if (buf.readUInt32LE(i) === SIG_END) return i;
  }
  return -1;
}

/**
 * Read a zip archive into a Map of entry name -> contents.
 *
 * Zip64 (an archive over 4 GB, or with more than 65,535 entries) is
 * detected and rejected with a clear message rather than silently
 * misread -- nothing a small business exports comes close to that size,
 * so hitting this means the file is not what it appears to be.
 */
export function unzip(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 22 || buf.readUInt32LE(0) !== SIG_LOCAL) {
    const looksLike = identifyNonZip(buf);
    throw new ZipFormatError(looksLike
      ? `This looks like ${looksLike}, not a zip-based file.`
      : 'This does not look like a zip archive.');
  }

  const endAt = findEnd(buf);
  if (endAt < 0) throw new ZipFormatError('This zip archive has no end-of-directory record -- it is truncated or corrupted.');

  let entryCount = buf.readUInt16LE(endAt + 10);
  let cdSize = buf.readUInt32LE(endAt + 12);
  let cdOffset = buf.readUInt32LE(endAt + 16);
  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipFormatError('This zip archive uses Zip64 (very large or very many entries), which is not supported.');
  }

  const out = new Map();
  let p = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new ZipFormatError('The central directory does not match its own entry count -- the archive is corrupted.');
    }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    // The local header repeats name/extra lengths and they are not always
    // identical to the central directory's -- some writers pad differently
    // -- so the actual data offset is computed from the local header's own
    // fields, never assumed from the central directory's.
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new ZipFormatError(`"${name}" has no valid local header -- the archive is corrupted.`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) {
      try { data = zlib.inflateRawSync(compressed); }
      catch (e) { throw new ZipFormatError(`"${name}" could not be decompressed: ${e.message}`); }
    } else {
      throw new ZipFormatError(`"${name}" uses an unsupported compression method (${method}).`);
    }
    if (data.length !== uncompSize) {
      throw new ZipFormatError(`"${name}" decompressed to the wrong size -- the archive is corrupted.`);
    }
    out.set(name, data);
  }
  return out;
}

export { ZipFormatError };
