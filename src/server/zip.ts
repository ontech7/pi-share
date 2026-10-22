import fs from 'node:fs';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';

export type ZipEntry = { name: string; absolute: string; size: number; modifiedAt: number };

function dosDateTime(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const LOCAL_HEADER = 30 + 20;
const DESCRIPTOR = 24;
const CENTRAL_HEADER = 46 + 28;
const END_RECORDS = 56 + 20 + 22;
const FLAGS = 0x0808; // sizes in the data descriptor, UTF-8 names
const VERSION = 45; // ZIP64

/** Unique names inside the archive: "a.txt", "a (2).txt", ... */
export function archiveNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    let candidate = name;
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let i = 2; used.has(candidate.toLowerCase()); i++) candidate = `${stem} (${i})${ext}`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

/** Exact size of what zipStream produces, so the browser can show real progress. */
export function zipSize(entries: Pick<ZipEntry, 'name' | 'size'>[]): number {
  return (
    entries.reduce((total, entry) => {
      const nameLength = Buffer.byteLength(entry.name);
      return total + LOCAL_HEADER + nameLength + entry.size + DESCRIPTOR + CENTRAL_HEADER + nameLength;
    }, 0) + END_RECORDS
  );
}

/** Uncompressed ZIP64 archive streamed straight from disk, without temporary files. */
export function zipStream(entries: ZipEntry[], signal?: AbortSignal): Readable {
  async function* generate() {
    const central: Buffer[] = [];
    let offset = 0;

    for (const entry of entries) {
      const name = Buffer.from(entry.name);
      const { time, date } = dosDateTime(entry.modifiedAt);
      const local = Buffer.alloc(LOCAL_HEADER + name.length);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(VERSION, 4);
      local.writeUInt16LE(FLAGS, 6);
      local.writeUInt16LE(0, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(0, 14);
      local.writeUInt32LE(0xffffffff, 18);
      local.writeUInt32LE(0xffffffff, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(20, 28);
      name.copy(local, 30);
      local.writeUInt16LE(0x0001, 30 + name.length);
      local.writeUInt16LE(16, 32 + name.length);
      yield local;

      let crc = 0;
      let written = 0;
      if (entry.size > 0) {
        for await (const chunk of fs.createReadStream(entry.absolute, { end: entry.size - 1, signal })) {
          crc = zlib.crc32(chunk as Buffer, crc);
          written += (chunk as Buffer).length;
          yield chunk as Buffer;
        }
      }
      if (written !== entry.size) throw new Error(`${entry.name} changed while being archived`);

      const descriptor = Buffer.alloc(DESCRIPTOR);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeBigUInt64LE(BigInt(written), 8);
      descriptor.writeBigUInt64LE(BigInt(written), 16);
      yield descriptor;

      const header = Buffer.alloc(CENTRAL_HEADER + name.length);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE((3 << 8) | VERSION, 4);
      header.writeUInt16LE(VERSION, 6);
      header.writeUInt16LE(FLAGS, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(time, 12);
      header.writeUInt16LE(date, 14);
      header.writeUInt32LE(crc, 16);
      header.writeUInt32LE(0xffffffff, 20);
      header.writeUInt32LE(0xffffffff, 24);
      header.writeUInt16LE(name.length, 28);
      header.writeUInt16LE(28, 30);
      header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
      header.writeUInt32LE(0xffffffff, 42);
      name.copy(header, 46);
      const extra = 46 + name.length;
      header.writeUInt16LE(0x0001, extra);
      header.writeUInt16LE(24, extra + 2);
      header.writeBigUInt64LE(BigInt(written), extra + 4);
      header.writeBigUInt64LE(BigInt(written), extra + 12);
      header.writeBigUInt64LE(BigInt(offset), extra + 20);
      central.push(header);

      offset += local.length + written + DESCRIPTOR;
    }

    const directory = Buffer.concat(central);
    yield directory;

    const end = Buffer.alloc(END_RECORDS);
    end.writeUInt32LE(0x06064b50, 0);
    end.writeBigUInt64LE(44n, 4);
    end.writeUInt16LE(VERSION, 12);
    end.writeUInt16LE(VERSION, 14);
    end.writeBigUInt64LE(BigInt(entries.length), 24);
    end.writeBigUInt64LE(BigInt(entries.length), 32);
    end.writeBigUInt64LE(BigInt(directory.length), 40);
    end.writeBigUInt64LE(BigInt(offset), 48);
    end.writeUInt32LE(0x07064b50, 56);
    end.writeBigUInt64LE(BigInt(offset + directory.length), 64);
    end.writeUInt32LE(1, 72);
    end.writeUInt32LE(0x06054b50, 76);
    end.writeUInt16LE(0xffff, 84);
    end.writeUInt16LE(0xffff, 86);
    end.writeUInt32LE(0xffffffff, 88);
    end.writeUInt32LE(0xffffffff, 92);
    yield end;
  }
  return Readable.from(generate());
}
