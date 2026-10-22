import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { archiveNames, zipSize, zipStream } from '../src/server/zip.ts';
import { tempDir, writeFiles } from './helpers.ts';

describe('zip', () => {
  it('writes an archive that standard tools read back, with the size announced in advance', async () => {
    const root = tempDir();
    const big = crypto.randomBytes(200_000);
    writeFiles(root, { 'a.txt': 'hello', 'empty.bin': '', 'dir/è big.bin': big });
    const entries = ['a.txt', 'empty.bin', 'dir/è big.bin'].map((relative) => {
      const absolute = path.join(root, relative);
      const stat = fs.statSync(absolute);
      return {
        name: path.basename(relative),
        size: stat.size,
        modifiedAt: stat.mtimeMs,
        open: () => fs.openSync(absolute, 'r'),
      };
    });

    const chunks: Buffer[] = [];
    for await (const chunk of zipStream(entries)) chunks.push(chunk as Buffer);
    const archive = Buffer.concat(chunks);
    expect(archive.length).toBe(zipSize(entries));

    const file = path.join(root, 'out.zip');
    fs.writeFileSync(file, archive);
    const check = execFileSync('python3', [
      '-c',
      'import sys,zipfile,hashlib;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print("\\n".join(f"{i.filename}|{i.file_size}|{hashlib.sha256(z.read(i)).hexdigest()}" for i in z.infolist()))',
      file,
    ]).toString();
    expect(check.trim().split('\n')).toEqual([
      `a.txt|5|${crypto.createHash('sha256').update('hello').digest('hex')}`,
      `empty.bin|0|${crypto.createHash('sha256').update('').digest('hex')}`,
      `è big.bin|200000|${crypto.createHash('sha256').update(big).digest('hex')}`,
    ]);
    expect(execFileSync('unzip', ['-t', file]).toString()).toContain('No errors detected');
  });

  it('renames duplicates inside the archive', () => {
    expect(archiveNames(['a.txt', 'A.txt', 'a.txt', 'b'])).toEqual(['a.txt', 'A (2).txt', 'a (3).txt', 'b']);
  });
});
