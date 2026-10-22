import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tempDir(prefix = 'pi-share-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function writeFiles(root: string, files: Record<string, string | Buffer>) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}
