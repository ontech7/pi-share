import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Storage } from '../src/server/storage.ts';
import { tempDir, writeFiles } from './helpers.ts';

describe('storage', () => {
  let root: string;
  let storage: Storage;

  beforeEach(() => {
    root = tempDir();
    writeFiles(root, {
      'Work/report.pdf': 'pdf',
      'Work/Signatures/sign.png': 'png',
      'Bank/statement.pdf': 'x',
      '.hidden/secret': 'x',
      '$RECYCLE.BIN/old': 'x',
      'notes.txt': 'n',
    });
    fs.symlinkSync('/etc', path.join(root, 'escape'));
    fs.symlinkSync(path.join(root, 'notes.txt'), path.join(root, 'link.txt'));
    storage = new Storage(root, ['bank', 'work/signatures']);
  });

  it('lists folders first and hides denied and system entries', () => {
    expect(storage.browse('').entries.map((entry) => entry.name)).toEqual(['Work', 'notes.txt']);
    expect(storage.browse('Work').entries.map((entry) => entry.name)).toEqual(['report.pdf']);
    expect(storage.browse('Work').parent).toBe('');
  });

  it('refuses traversal, denied folders, hidden names and symbolic links', () => {
    expect(() => storage.file('../etc/passwd')).toThrow('invalid');
    expect(() => storage.file('Work/../../x')).toThrow('invalid');
    expect(() => storage.file('BANK/statement.pdf')).toThrow('denied');
    expect(() => storage.file('Work/Signatures/sign.png')).toThrow('denied');
    expect(() => storage.file('.hidden/secret')).toThrow('denied');
    expect(() => storage.browse('escape')).toThrow('denied');
    expect(() => storage.file('link.txt')).toThrow('symbolic links');
    expect(() => storage.file('Work')).toThrow('not_a_file');
    expect(() => storage.file('nope.txt')).toThrow('not_found');
  });

  it('tells whether a linked file is still the same', () => {
    const file = storage.file('/Work//report.pdf');
    expect(file.path).toBe('Work/report.pdf');
    expect(storage.state(file)).toBe('ok');
    fs.writeFileSync(path.join(root, 'Work/report.pdf'), 'changed');
    expect(storage.state(file)).toBe('changed');
    fs.rmSync(path.join(root, 'Work/report.pdf'));
    expect(storage.state(file)).toBe('missing');
  });
});

describe('storage permissions', () => {
  it.skipIf(process.getuid?.() === 0)('reports a folder it may not read as unreadable', () => {
    const root = tempDir();
    writeFiles(root, { 'Locked/photo.jpg': 'x' });
    fs.chmodSync(path.join(root, 'Locked'), 0o000);
    try {
      expect(() => new Storage(root).browse('Locked')).toThrow(expect.objectContaining({ code: 'unreadable' }));
    } finally {
      fs.chmodSync(path.join(root, 'Locked'), 0o755);
    }
  });
});
