import fs from 'node:fs';
import path from 'node:path';
import type { BrowseEntry, BrowseResult, FileState } from '../shared/api.ts';

const SYSTEM_NAMES = new Set(['system volume information', 'lost+found']);

export type StorageErrorCode = 'invalid' | 'denied' | 'not_found' | 'not_a_file' | 'changed';

export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string = code) {
    super(message);
    this.code = code;
  }
}

export type StoredFile = { path: string; absolute: string; name: string; size: number; modifiedAt: number };

/** Read-only view of the shared folder. Every path is relative to the root and checked against escapes and the deny list. */
export class Storage {
  private readonly realRoot: string;
  private readonly deny: string[];
  private readonly hideSystem: boolean;

  constructor(root: string, deny: string[] = [], hideSystem = true) {
    this.realRoot = fs.realpathSync(root);
    this.deny = deny;
    this.hideSystem = hideSystem;
  }

  normalize(relative: string): string {
    if (relative.includes('\0')) throw new StorageError('invalid');
    const segments = relative.split(/[\\/]+/).filter((s) => s && s !== '.');
    if (segments.includes('..')) throw new StorageError('invalid');
    return segments.join('/');
  }

  isHidden(relative: string): boolean {
    const lower = relative.toLowerCase();
    if (this.deny.some((entry) => lower === entry || lower.startsWith(`${entry}/`))) return true;
    if (!this.hideSystem) return false;
    return lower
      .split('/')
      .some((segment) => segment.startsWith('.') || segment.startsWith('$') || SYSTEM_NAMES.has(segment));
  }

  private resolve(relative: string): { relative: string; absolute: string } {
    const clean = this.normalize(relative);
    if (clean && this.isHidden(clean)) throw new StorageError('denied');
    const absolute = path.join(this.realRoot, clean);
    let real: string;
    try {
      real = fs.realpathSync(absolute);
    } catch {
      throw new StorageError('not_found');
    }
    if (real !== this.realRoot && !real.startsWith(this.realRoot + path.sep)) throw new StorageError('denied');
    if (real !== absolute) throw new StorageError('denied', 'symbolic links are not followed');
    return { relative: clean, absolute };
  }

  browse(relative = ''): BrowseResult {
    const { relative: clean, absolute } = this.resolve(relative);
    const entries: BrowseEntry[] = [];
    for (const dirent of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (!dirent.isFile() && !dirent.isDirectory()) continue;
      const entryPath = clean ? `${clean}/${dirent.name}` : dirent.name;
      if (this.isHidden(entryPath)) continue;
      try {
        const stat = fs.statSync(path.join(absolute, dirent.name));
        entries.push({
          name: dirent.name,
          path: entryPath,
          type: dirent.isDirectory() ? 'dir' : 'file',
          size: dirent.isDirectory() ? 0 : stat.size,
          modifiedAt: Math.trunc(stat.mtimeMs),
        });
      } catch {
        // vanished while listing
      }
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    const parent = clean ? clean.split('/').slice(0, -1).join('/') : null;
    return { path: clean, parent, entries };
  }

  file(relative: string): StoredFile {
    const { relative: clean, absolute } = this.resolve(relative);
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) throw new StorageError('not_a_file');
    return { path: clean, absolute, name: path.basename(clean), size: stat.size, modifiedAt: Math.trunc(stat.mtimeMs) };
  }

  /**
   * Opens a linked file for reading and proves the descriptor is that file: no symlink at the end
   * (O_NOFOLLOW), still inside the root (the kernel's own path for the descriptor, where available),
   * same inode as the checked path, same size and modification time as when it was linked.
   */
  open(stored: { path: string; size: number; modifiedAt: number }): number {
    const { absolute } = this.resolve(stored.path);
    const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile()) throw new StorageError('not_a_file');
      const kernelPath = descriptorPath(fd);
      if (kernelPath !== absolute && (kernelPath !== null || process.platform === 'linux')) {
        throw new StorageError('denied');
      }
      this.assertNoSymlinks(stored.path);
      const checked = fs.statSync(absolute);
      if (checked.ino !== opened.ino || checked.dev !== opened.dev) throw new StorageError('denied');
      if (opened.size !== stored.size || Math.trunc(opened.mtimeMs) !== stored.modifiedAt)
        throw new StorageError('changed');
      return fd;
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }

  /** Where the kernel cannot name the descriptor's path, check every level of the path is a real directory. */
  private assertNoSymlinks(relative: string) {
    let current = this.realRoot;
    for (const segment of this.normalize(relative).split('/')) {
      current = path.join(current, segment);
      if (fs.lstatSync(current).isSymbolicLink()) throw new StorageError('denied');
    }
  }

  state(stored: { path: string; size: number; modifiedAt: number }): FileState {
    try {
      const current = this.file(stored.path);
      return current.size === stored.size && current.modifiedAt === stored.modifiedAt ? 'ok' : 'changed';
    } catch {
      return 'missing';
    }
  }
}

function descriptorPath(fd: number): string | null {
  try {
    return fs.readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return null;
  }
}
