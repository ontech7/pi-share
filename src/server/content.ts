import type { ChangePolicy, ChangeView, FileState, ItemChanges, ItemKind } from '../shared/api.ts';
import { sha256 } from './crypto.ts';
import type { SensitiveList } from './sensitive.ts';
import type { FolderFile, Storage, StoredFile } from './storage.ts';
import { archiveNames } from './zip.ts';

export type Item = { position: number; kind: ItemKind; path: string; name: string; size: number; modifiedAt: number };
export type Snapshot = { position: number; relative: string; size: number; modifiedAt: number };

/** A file the link can serve: `source` is where it lives under the storage root, `path` is what the recipient sees. */
export type Entry = { id: string; position: number; path: string; source: string; size: number; modifiedAt: number };

export type ItemReport = {
  item: Item;
  name: string;
  state: FileState;
  changes: ItemChanges | null;
  size: number;
  fileCount: number;
};

export type Inspection = {
  items: ItemReport[];
  /** What may be downloaded right now under the link's policy. */
  entries: Entry[];
  changes: ChangeView[];
  changed: boolean;
};

export type ContentDeps = { storage: Storage; sensitive: SensitiveList };

export const entryId = (position: number, relative: string) => sha256(`${position}:${relative}`).slice(0, 16);

/**
 * Compares what a link shares with what is on disk now. Files that turn out to be sensitive and were not
 * there when the link was made (or last accepted) are left out entirely: never served, never reported.
 */
export function inspect(
  items: Item[],
  snapshots: Snapshot[],
  policy: ChangePolicy,
  { storage, sensitive }: ContentDeps,
): Inspection {
  const names = archiveNames(items.map((item) => item.name));
  const reports: ItemReport[] = [];
  const entries: Entry[] = [];
  const changes: ChangeView[] = [];
  const isSensitive = (file: { path: string; size: number; modifiedAt: number }) => {
    try {
      return sensitive.matches({ ...file, absolute: storage.absolute(file.path) });
    } catch {
      return true;
    }
  };

  items.forEach((item, index) => {
    const name = names[index] as string;
    if (item.kind === 'file') {
      const current = currentFile(storage, item.path);
      const same = current !== null && current.size === item.size && current.modifiedAt === item.modifiedAt;
      const state: FileState = current === null ? 'missing' : same ? 'ok' : 'changed';
      if (state !== 'ok') changes.push({ path: name, change: state === 'missing' ? 'removed' : 'changed' });
      const served = same ? item : current && policy === 'follow' && !isSensitive(current) ? current : null;
      if (served) {
        entries.push({
          id: entryId(item.position, ''),
          position: item.position,
          path: name,
          source: item.path,
          size: served.size,
          modifiedAt: served.modifiedAt,
        });
      }
      reports.push({ item, name, state, changes: null, size: served?.size ?? item.size, fileCount: 1 });
      return;
    }

    const before = snapshots.filter((snapshot) => snapshot.position === item.position);
    const snapshotSize = before.reduce((sum, snapshot) => sum + snapshot.size, 0);
    const files = currentFolder(storage, item.path);
    if (files === null) {
      changes.push({ path: name, change: 'removed' });
      reports.push({ item, name, state: 'missing', changes: null, size: snapshotSize, fileCount: before.length });
      return;
    }

    const known = new Map(before.map((snapshot) => [snapshot.relative, snapshot]));
    const counts: ItemChanges = { added: 0, removed: 0, changed: 0 };
    const served: Entry[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      seen.add(file.relative);
      const old = known.get(file.relative);
      const same = old !== undefined && old.size === file.size && old.modifiedAt === file.modifiedAt;
      if (!same && isSensitive(file)) continue;
      const path = `${name}/${file.relative}`;
      if (!old) {
        counts.added++;
        changes.push({ path, change: 'added' });
      } else if (!same) {
        counts.changed++;
        changes.push({ path, change: 'changed' });
      }
      if (same || policy === 'follow') {
        served.push({
          id: entryId(item.position, file.relative),
          position: item.position,
          path,
          source: file.path,
          size: file.size,
          modifiedAt: file.modifiedAt,
        });
      }
    }
    for (const snapshot of before) {
      if (seen.has(snapshot.relative)) continue;
      counts.removed++;
      changes.push({ path: `${name}/${snapshot.relative}`, change: 'removed' });
    }

    const dirty = counts.added + counts.removed + counts.changed > 0;
    entries.push(...served);
    reports.push({
      item,
      name,
      state: dirty ? 'changed' : 'ok',
      changes: counts,
      size: policy === 'follow' ? served.reduce((sum, entry) => sum + entry.size, 0) : snapshotSize,
      fileCount: policy === 'follow' ? served.length : before.length,
    });
  });

  return { items: reports, entries, changes, changed: changes.length > 0 };
}

/** The files of a folder as they are now, without the sensitive ones unless the owner confirmed them. */
export function folderSnapshot(
  { storage, sensitive }: ContentDeps,
  folder: string,
  includeSensitive: boolean,
): { files: FolderFile[]; flagged: string[] } {
  const files: FolderFile[] = [];
  const flagged: string[] = [];
  for (const file of storage.walk(folder)) {
    if (sensitive.matches({ ...file, absolute: storage.absolute(file.path) })) {
      flagged.push(file.path);
      if (!includeSensitive) continue;
    }
    files.push(file);
  }
  return { files, flagged };
}

function currentFile(storage: Storage, path: string): StoredFile | null {
  try {
    return storage.file(path);
  } catch {
    return null;
  }
}

function currentFolder(storage: Storage, path: string): FolderFile[] | null {
  try {
    return storage.walk(path);
  } catch {
    return null;
  }
}
