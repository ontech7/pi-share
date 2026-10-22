import crypto from 'node:crypto';
import fs from 'node:fs';

type Entry = { sha256: string; size: number; path: string | null };

export type CheckedFile = { path: string; absolute: string; size: number; modifiedAt: number };

const HASH_CHUNK = 1024 * 1024;

/**
 * Optional list of files marked as sensitive somewhere else, one "sha256 size [path]" per line.
 * Only files whose size matches an entry get hashed, so large shares stay cheap to create.
 */
export class SensitiveList {
  private entries: Entry[] = [];
  private loadedAt = -1;
  private readonly verdicts = new Map<string, { size: number; modifiedAt: number; sensitive: boolean }>();
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  private reload() {
    if (!this.file) return;
    let modifiedAt: number;
    try {
      modifiedAt = fs.statSync(this.file).mtimeMs;
    } catch {
      this.entries = [];
      return;
    }
    if (modifiedAt === this.loadedAt) return;
    this.entries = fs
      .readFileSync(this.file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .flatMap((line) => {
        const [sha256, size, ...rest] = line.split(/\s+/);
        if (!sha256 || !/^[a-f0-9]{64}$/i.test(sha256) || !Number.isFinite(Number(size))) return [];
        return [{ sha256: sha256.toLowerCase(), size: Number(size), path: rest.join(' ') || null }];
      });
    this.loadedAt = modifiedAt;
    this.verdicts.clear();
  }

  /** Answers are remembered per path until the file or the list changes: live folders ask again on every visit. */
  matches(file: CheckedFile): boolean {
    this.reload();
    if (this.entries.some((entry) => entry.path === file.path)) return true;
    const candidates = this.entries.filter((entry) => entry.size === file.size);
    if (candidates.length === 0) return false;
    const known = this.verdicts.get(file.path);
    if (known && known.size === file.size && known.modifiedAt === file.modifiedAt) return known.sensitive;
    const digest = hashFile(file.absolute);
    const sensitive = digest !== null && candidates.some((entry) => entry.sha256 === digest);
    this.verdicts.set(file.path, { size: file.size, modifiedAt: file.modifiedAt, sensitive });
    return sensitive;
  }
}

function hashFile(absolute: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(HASH_CHUNK);
    for (let read = fs.readSync(fd, buffer); read > 0; read = fs.readSync(fd, buffer))
      hash.update(buffer.subarray(0, read));
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}
