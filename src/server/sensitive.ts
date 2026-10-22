import crypto from 'node:crypto';
import fs from 'node:fs';

type Entry = { sha256: string; size: number; path: string | null };

export type CheckedFile = { path: string; size: number; modifiedAt: number };

const RELOAD_INTERVAL = 1_000;

const HASH_CHUNK = 1024 * 1024;

/**
 * Optional list of files marked as sensitive somewhere else, one "sha256 size [path]" per line.
 * Only files whose size matches an entry get hashed, so large shares stay cheap to create.
 */
export class SensitiveList {
  private entries: Entry[] = [];
  private loadedAt = -1;
  private checkedAt = 0;
  private fingerprint = '';
  private readonly verdicts = new Map<string, { size: number; modifiedAt: number; sensitive: boolean }>();
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  private reload() {
    if (!this.file || Date.now() - this.checkedAt < RELOAD_INTERVAL) return;
    this.checkedAt = Date.now();
    // Stat and read the same open file, so a list swapped in between cannot mix two versions.
    let fd: number;
    try {
      fd = fs.openSync(this.file, 'r');
    } catch {
      this.entries = [];
      this.loadedAt = -1;
      this.fingerprint = '';
      return;
    }
    let content: string;
    try {
      const modifiedAt = fs.fstatSync(fd).mtimeMs;
      if (modifiedAt === this.loadedAt) return;
      content = fs.readFileSync(fd, 'utf8');
      this.loadedAt = modifiedAt;
    } finally {
      fs.closeSync(fd);
    }
    // The list is rewritten on a timer even when nothing changed: keep the verdicts unless its content did.
    const fingerprint = crypto.createHash('sha256').update(content).digest('hex');
    if (fingerprint === this.fingerprint) return;
    this.fingerprint = fingerprint;
    this.verdicts.clear();
    this.entries = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .flatMap((line) => {
        const [sha256, size, ...rest] = line.split(/\s+/);
        if (!sha256 || !/^[a-f0-9]{64}$/i.test(sha256) || !Number.isFinite(Number(size))) return [];
        return [{ sha256: sha256.toLowerCase(), size: Number(size), path: rest.join(' ') || null }];
      });
  }

  /**
   * Answers are remembered per path until the file or the list changes: live folders ask again on every visit.
   * Only a file whose size matches an entry is read, so `absolute` is resolved only then.
   */
  matches(file: CheckedFile, absolute: string | (() => string)): boolean {
    this.reload();
    if (this.entries.some((entry) => entry.path === file.path)) return true;
    const candidates = this.entries.filter((entry) => entry.size === file.size);
    if (candidates.length === 0) return false;
    const known = this.verdicts.get(file.path);
    if (known && known.size === file.size && known.modifiedAt === file.modifiedAt) return known.sensitive;
    const digest = hashFile(typeof absolute === 'string' ? absolute : absolute());
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
