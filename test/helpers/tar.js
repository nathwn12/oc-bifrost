/**
 * In-memory tar fixtures for the github: snapshot tests — the inverse of
 * src/archive.ts, deliberately dumb, built with node:zlib only. Not a test
 * file: `node --test test/*.test.js` never runs this.
 */
export const BLOCK = 512

export function field(header, offset, length, value) {
  const bytes = Buffer.from(value, "utf8")
  if (bytes.length > length) throw new Error(`fixture field "${value}" does not fit in ${length} bytes`)
  bytes.copy(header, offset)
}

export function rawHeader({ name = "", size = 0, type = "0", linkname = "", prefix, badChecksum = false, sizeField }) {
  const header = Buffer.alloc(BLOCK)
  if (prefix !== undefined) field(header, 345, 155, prefix)
  field(header, 0, 100, name)
  field(header, 100, 8, "0000644\0")
  field(header, 108, 8, "0000000\0")
  field(header, 116, 8, "0000000\0")
  if (sizeField === undefined) field(header, 124, 12, `${size.toString(8).padStart(11, "0")}\0`)
  else Buffer.from(sizeField).copy(header, 124)
  field(header, 136, 12, "00000000000\0")
  field(header, 148, 8, "        ")
  field(header, 156, 1, type)
  field(header, 157, 100, linkname)
  field(header, 257, 6, "ustar\0")
  field(header, 263, 2, "00")
  let sum = 0
  for (const byte of header) sum += byte
  field(header, 148, 8, badChecksum ? "000000\0 " : `${sum.toString(8).padStart(6, "0")}\0 `)
  return header
}

export function entry(name, data = "", opts = {}) {
  const body = Buffer.from(data)
  return { header: rawHeader({ name, size: body.length, ...opts }), body }
}

export function tar(...entries) {
  const parts = []
  for (const e of entries) {
    parts.push(e.header)
    if (e.body.length > 0) parts.push(e.body)
    const remainder = e.body.length % BLOCK
    if (remainder !== 0) parts.push(Buffer.alloc(BLOCK - remainder))
  }
  parts.push(Buffer.alloc(BLOCK * 2))
  return Buffer.concat(parts)
}

export function paxRecord(key, value) {
  const payload = `${key}=${value}\n`
  let length = payload.length + 2
  while (`${length}`.length + 1 + payload.length !== length) {
    length = `${length}`.length + 1 + payload.length
  }
  return `${length} ${payload}`
}

export function paxEntry(records) {
  const data = records.map(([key, value]) => paxRecord(key, value)).join("")
  return entry("PaxHeaders/x", data, { type: "x" })
}

export function gnuNameEntry(longName) {
  return entry("././@LongLink", `${longName}\0`, { type: "L" })
}

export function base256(value, length = 12) {
  const bytes = Buffer.alloc(length)
  Buffer.from(value.toString(16).padStart((length - 1) * 2, "0"), "hex").copy(bytes, 1)
  bytes[0] = 0x80
  return bytes
}
