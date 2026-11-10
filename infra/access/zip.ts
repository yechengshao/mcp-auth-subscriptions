const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_HEADER = 0x06054b50;
const UTF8_FLAG = 0x0800;
const DOS_DATE_2020_01_01 = 0x5021;

export interface ZipEntry { name: string; data: Uint8Array | string }

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(data: Uint8Array): number {
  let checksum = 0xffffffff;
  for (const byte of data) checksum = crcTable[(checksum ^ byte) & 0xff]! ^ (checksum >>> 8);
  return (checksum ^ 0xffffffff) >>> 0;
}

function safeName(name: string): string {
  const normalized = name.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some(part => part === '..' || part === '.')) {
    throw new Error('invalid_zip_entry_name');
  }
  return normalized;
}

export function createStoredZip(input: readonly ZipEntry[]): Buffer {
  if (input.length === 0 || input.length > 0xffff) throw new Error('invalid_zip_entry_count');
  const entries = input.map(entry => ({ name: safeName(entry.name), nameBytes: Buffer.from(safeName(entry.name), 'utf8'), data: Buffer.from(entry.data) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (new Set(entries.map(entry => entry.name)).size !== entries.length || entries.some(entry => entry.nameBytes.length > 0xffff || entry.data.length > 0xffffffff)) {
    throw new Error('invalid_zip_entry');
  }

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE_2020_01_01, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(entry.nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, entry.nameBytes, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE_2020_01_01, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(entry.nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0x81a40000, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, entry.nameBytes);
    localOffset += local.length + entry.nameBytes.length + entry.data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  if (centralDirectory.length > 0xffffffff || localOffset > 0xffffffff) throw new Error('zip32_size_limit_exceeded');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_HEADER, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function readStoredZip(archive: Uint8Array): Map<string, Buffer> {
  const bytes = Buffer.from(archive);
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 4 <= bytes.length && bytes.readUInt32LE(offset) === LOCAL_HEADER) {
    if (offset + 30 > bytes.length) throw new Error('truncated_zip_header');
    const flags = bytes.readUInt16LE(offset + 6);
    const method = bytes.readUInt16LE(offset + 8);
    const checksum = bytes.readUInt32LE(offset + 14);
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const uncompressedSize = bytes.readUInt32LE(offset + 22);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const dataOffset = offset + 30 + nameLength + extraLength;
    const dataEnd = dataOffset + compressedSize;
    if ((flags & 0x0008) !== 0 || method !== 0 || compressedSize !== uncompressedSize || dataEnd > bytes.length) {
      throw new Error('unsupported_zip_entry');
    }
    const name = safeName(bytes.toString('utf8', offset + 30, offset + 30 + nameLength));
    const data = bytes.subarray(dataOffset, dataEnd);
    if (crc32(data) !== checksum || files.has(name)) throw new Error('invalid_zip_entry_checksum');
    files.set(name, Buffer.from(data));
    offset = dataEnd;
  }
  if (files.size === 0 || offset + 4 > bytes.length || bytes.readUInt32LE(offset) !== CENTRAL_HEADER) throw new Error('invalid_zip_archive');
  return files;
}
