import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const created = new Set<string>();

/** A fresh directory under the system temp dir, removed after the test file by `removeTempDirs` (test/setup.ts). */
export function tempDir(prefix = 'pi-share-'): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.add(dir);
  return dir;
}

export function removeTempDirs() {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  created.clear();
}

export function writeFiles(root: string, files: Record<string, string | Buffer>) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}
