import crypto from 'node:crypto';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { StoredFile } from './storage.ts';

type Entry = { sha256: string; size: number; path: string | null };

/**
 * Optional list of files marked as sensitive somewhere else, one "sha256 size [path]" per line.
 * Only files whose size matches an entry get hashed, so large shares stay cheap to create.
 */
export class SensitiveList {
  private entries: Entry[] = [];
  private loadedAt = -1;
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
  }

  async matches(file: StoredFile): Promise<boolean> {
    this.reload();
    if (this.entries.some((entry) => entry.path === file.path)) return true;
    const candidates = this.entries.filter((entry) => entry.size === file.size);
    if (candidates.length === 0) return false;
    const hash = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(file.absolute), hash);
    const digest = hash.digest('hex');
    return candidates.some((entry) => entry.sha256 === digest);
  }
}
