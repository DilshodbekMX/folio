/**
 * A minimal ZIP writer for "Download all" output files: stored entries (no compression — the
 * outputs are small or already compressed: PDF, .synctex.gz), UTF-8 names, ZIP32 limits
 * (< 4 GB, < 65 535 entries). Pure, so it can be tested in Node.
 */

export interface ZipEntry {
  name: string
  data: Uint8Array
  /** modification time stored in the archive (default: now) */
  date?: Date
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** MS-DOS date/time fields (local time, 2-second resolution, years 1980–2107). */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107)
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

const UTF8_FLAG = 0x0800
const VERSION = 20

/** Build a .zip archive of `entries` (names must be unique relative paths with '/' separators). */
export function zipStore(entries: readonly ZipEntry[]): Blob {
  if (entries.length > 0xffff) throw new Error('Too many files for a zip archive')
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const e of entries) {
    const name = enc.encode(e.name)
    const size = e.data.length
    if (offset + 30 + name.length + size > 0xffffffff) throw new Error('The files are too large for a zip archive')
    const crc = crc32(e.data)
    const { time, date } = dosDateTime(e.date ?? new Date())

    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true) // local file header
    local.setUint16(4, VERSION, true)
    local.setUint16(6, UTF8_FLAG, true)
    local.setUint16(8, 0, true) // stored
    local.setUint16(10, time, true)
    local.setUint16(12, date, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, size, true)
    local.setUint32(22, size, true)
    local.setUint16(26, name.length, true)
    local.setUint16(28, 0, true)
    parts.push(new Uint8Array(local.buffer), name, e.data)

    const cd = new DataView(new ArrayBuffer(46))
    cd.setUint32(0, 0x02014b50, true) // central directory header
    cd.setUint16(4, VERSION, true) // made by
    cd.setUint16(6, VERSION, true) // needed
    cd.setUint16(8, UTF8_FLAG, true)
    cd.setUint16(10, 0, true)
    cd.setUint16(12, time, true)
    cd.setUint16(14, date, true)
    cd.setUint32(16, crc, true)
    cd.setUint32(20, size, true)
    cd.setUint32(24, size, true)
    cd.setUint16(28, name.length, true)
    // extra, comment, disk, internal and external attributes: 0
    cd.setUint32(42, offset, true)
    central.push(new Uint8Array(cd.buffer), name)
    offset += 30 + name.length + size
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true) // end of central directory
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, cdSize, true)
  end.setUint32(16, offset, true)
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)] as BlobPart[], { type: 'application/zip' })
}
