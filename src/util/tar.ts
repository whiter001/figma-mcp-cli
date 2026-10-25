import { gunzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';

const BLOCK = 512;

interface TarEntry {
  name: string;
  type: 'file' | 'dir';
  data: Buffer;
}

/**
 * Minimal tar reader (ustar / GNU long names / pax path headers).
 * Enough to unpack a GitHub source tarball without pulling in a dependency.
 */
export function readTar(buffer: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | undefined;
  let paxPath: string | undefined;

  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    offset += BLOCK;

    if (isZeroBlock(header)) break;

    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const data = buffer.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === 'L') {
      // GNU long name — applies to the next entry.
      longName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (typeflag === 'x' || typeflag === 'X') {
      // pax extended header — only "path=" is relevant here.
      paxPath = readPaxPath(data.toString('utf8'));
      continue;
    }

    const prefix = readString(header, 345, 155);
    const base = readString(header, 0, 100);
    let name = longName ?? paxPath ?? (prefix ? `${prefix}/${base}` : base);
    longName = undefined;
    paxPath = undefined;

    if (typeflag === '5') {
      entries.push({ name: `${name.replace(/\/+$/, '')}/`, type: 'dir', data: Buffer.alloc(0) });
      continue;
    }
    if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      entries.push({ name, type: 'file', data });
    }
    // Other types (symlinks, links) are skipped on purpose.
  }

  return entries;
}

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

function readString(buffer: Buffer, start: number, length: number): string {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8').trim();
}

function readOctal(buffer: Buffer, start: number, length: number): number {
  const raw = readString(buffer, start, length).replace(/[^0-7]/g, '');
  return raw ? parseInt(raw, 8) : 0;
}

function readPaxPath(content: string): string | undefined {
  for (const line of content.split('\n')) {
    const match = /^\d+ path=(.*)$/.exec(line.trim());
    if (match) return match[1];
  }
  return undefined;
}

/** Unpack a .tar.gz buffer into `targetDir`. */
export function extractTarGz(buffer: Buffer, targetDir: string): number {
  const entries = readTar(gunzipSync(buffer));
  let written = 0;

  for (const entry of entries) {
    // Guard against path traversal (../../etc/passwd).
    const safe = normalize(entry.name).replace(/^([/\\]|\.\.[/\\])+/, '');
    if (!safe || safe === '.' || safe.startsWith('..')) continue;

    const dest = join(targetDir, safe);
    if (!dest.startsWith(targetDir + sep) && dest !== targetDir) continue;

    if (entry.type === 'dir') {
      mkdirSync(dest, { recursive: true });
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, entry.data);
    written += 1;
  }

  return written;
}
