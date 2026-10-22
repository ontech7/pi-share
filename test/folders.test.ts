import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { entryId } from '../src/server/content.ts';
import type { LinkDetail, ShareMeta } from '../src/shared/api.ts';
import { decryptStream, openMeta, type Sealed } from '../src/shared/wire.ts';
import { tempDir, writeFiles } from './helpers.ts';
import { startStack } from './stack.ts';

let stack: Awaited<ReturnType<typeof startStack>>;
let ip = 0;
const secret = 'top secret contract';
const sensitiveDir = tempDir();

beforeAll(async () => {
  const digest = crypto.createHash('sha256').update(secret).digest('hex');
  fs.writeFileSync(path.join(sensitiveDir, 'sensitive.txt'), `${digest} ${secret.length}\n`);
  stack = await startStack(
    {
      'Photos/a.jpg': 'aaaa',
      'Photos/2023/b.jpg': 'bbbbbb',
      'Photos/.thumbs/c.jpg': 'hidden',
      'Photos/private/d.jpg': 'denied',
      'Live/one.txt': '1',
      'Mixed/ok.txt': 'fine',
      'Mixed/contract.txt': secret,
    },
    { DENY_PATHS: 'Photos/private', SENSITIVE_FILE: path.join(sensitiveDir, 'sensitive.txt') },
  );
});

afterAll(() => stack.close());

const create = async (body: Record<string, unknown>) => {
  const response = await stack.adminCall('POST', '/api/links', body);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body as LinkDetail;
};

const detail = async (link: LinkDetail) => (await stack.adminCall('GET', `/api/links/${link.id}`)).body as LinkDetail;

/** Opens the link as a fresh recipient and returns what their browser would decrypt. */
const receive = async (link: LinkDetail) => {
  const visitor = await stack.visit(link.id, `203.0.113.${++ip}`);
  const response = await stack.open(visitor, link);
  if (response.statusCode !== 200) return { status: response.statusCode, body: response.json() };
  const { meta, ticket } = response.json() as { meta: Sealed; ticket: string };
  const { key } = stack.keyOf(link);
  const download = async (part: string) => {
    const file = await stack.call(visitor, 'GET', `/api/links/${link.id}/files/${part}`, undefined, ticket);
    if (file.statusCode !== 200) return null;
    const source = new Blob([new Uint8Array(file.rawPayload)]).stream();
    return Buffer.from(await new Response(source.pipeThrough(decryptStream(key, link.id, part))).arrayBuffer());
  };
  return { status: 200, meta: await openMeta<ShareMeta>(key, link.id, meta), download };
};

const write = (files: Record<string, string>) => writeFiles(stack.storageRoot, files);

describe('sharing a folder', () => {
  let link: LinkDetail;

  it('lets the picker select folders and shares everything below them', async () => {
    link = await create({ paths: ['Photos'] });
    expect(link.items).toMatchObject([{ kind: 'folder', name: 'Photos', fileCount: 2, size: 10, state: 'ok' }]);
    expect(link.onChange).toBe('pause');
  });

  it('shows the recipient the tree, without hidden or denied files', async () => {
    const received = await receive(link);
    expect(received.meta?.entries).toEqual([
      { id: entryId(0, '2023/b.jpg'), path: 'Photos/2023/b.jpg', size: 6 },
      { id: entryId(0, 'a.jpg'), path: 'Photos/a.jpg', size: 4 },
    ]);
    expect(received.meta?.bundle?.name).toBe('Photos.zip');
  });

  it('serves single files from inside the folder and the whole folder as a zip', async () => {
    const received = await receive(link);
    expect((await received.download?.(entryId(0, 'a.jpg')))?.toString()).toBe('aaaa');
    const archive = (await received.download?.('all')) as Buffer;
    expect(archive.length).toBe(received.meta?.bundle?.size);
    const zipFile = path.join(stack.root, 'photos.zip');
    fs.writeFileSync(zipFile, archive);
    const listing = execFileSync('unzip', ['-l', zipFile]).toString();
    expect(listing).toContain('Photos/2023/b.jpg');
    expect(listing).not.toContain('d.jpg');
    expect(listing).not.toContain('thumbs');
  });

  it('refuses an id that is not one of the entries', async () => {
    const received = await receive(link);
    expect(await received.download?.(entryId(0, 'private/d.jpg'))).toBeNull();
    expect(await received.download?.(entryId(1, ''))).toBeNull();
  });

  it('pauses when a file is added, and resumes with it once accepted', async () => {
    write({ 'Photos/2023/new.jpg': 'new!' });
    let current = await detail(link);
    expect(current.state).toBe('paused');
    expect(current.items[0]?.changes).toEqual({ added: 1, removed: 0, changed: 0 });
    expect(current.changes).toEqual([{ path: 'Photos/2023/new.jpg', change: 'added' }]);
    expect(await receive(link)).toMatchObject({ status: 404, body: { reason: 'paused' } });

    current = (await stack.adminCall('PATCH', `/api/links/${link.id}`, { acceptChanges: true })).body;
    expect(current.state).toBe('active');
    expect(current.items[0]).toMatchObject({ fileCount: 3, size: 14, changes: { added: 0, removed: 0, changed: 0 } });
    expect((await receive(link)).meta?.entries.map((entry) => entry.path)).toContain('Photos/2023/new.jpg');
  });

  it('pauses when a file is removed or changed', async () => {
    fs.rmSync(path.join(stack.storageRoot, 'Photos/2023/new.jpg'));
    write({ 'Photos/a.jpg': 'aaaaaaaa' });
    const current = await detail(link);
    expect(current.state).toBe('paused');
    expect(current.items[0]?.changes).toEqual({ added: 0, removed: 1, changed: 1 });
  });

  it('becomes unavailable once the folder itself is gone, and accepting drops it', async () => {
    fs.renameSync(path.join(stack.storageRoot, 'Photos'), path.join(stack.storageRoot, 'Moved'));
    let current = await detail(link);
    expect(current.state).toBe('unavailable');
    expect(current.items[0]?.state).toBe('missing');
    current = (await stack.adminCall('PATCH', `/api/links/${link.id}`, { acceptChanges: true })).body;
    expect(current.items).toEqual([]);
    fs.renameSync(path.join(stack.storageRoot, 'Moved'), path.join(stack.storageRoot, 'Photos'));
  });
});

describe('following a live folder', () => {
  let link: LinkDetail;

  it('serves what the folder holds now, without pausing', async () => {
    link = await create({ paths: ['Live'], onChange: 'follow' });
    write({ 'Live/two.txt': '22' });
    const current = await detail(link);
    expect(current.state).toBe('active');
    expect(current.items[0]).toMatchObject({ fileCount: 2, size: 3, changes: { added: 1, removed: 0, changed: 0 } });
    const received = await receive(link);
    expect(received.meta?.entries.map((entry) => entry.path)).toEqual(['Live/one.txt', 'Live/two.txt']);
    expect((await received.download?.(entryId(0, 'two.txt')))?.toString()).toBe('22');
  });

  it('serves the new content of a changed file and drops removed ones', async () => {
    write({ 'Live/one.txt': 'one, longer' });
    fs.rmSync(path.join(stack.storageRoot, 'Live/two.txt'));
    const received = await receive(link);
    expect(received.meta?.entries).toEqual([{ id: entryId(0, 'one.txt'), path: 'Live/one.txt', size: 11 }]);
    expect((await received.download?.(entryId(0, 'one.txt')))?.toString()).toBe('one, longer');
  });

  it('never serves nor reports a sensitive file that shows up later', async () => {
    write({ 'Live/contract.txt': secret });
    const current = await detail(link);
    expect(current.changes.map((change) => change.path)).not.toContain('Live/contract.txt');
    const received = await receive(link);
    expect(received.meta?.entries.map((entry) => entry.path)).not.toContain('Live/contract.txt');
    expect(await received.download?.(entryId(0, 'contract.txt'))).toBeNull();
  });

  it('can switch back to pausing on changes', async () => {
    const current = (await stack.adminCall('PATCH', `/api/links/${link.id}`, { onChange: 'pause' })).body;
    expect(current).toMatchObject({ onChange: 'pause', state: 'paused' });
  });
});

describe('sensitive files inside a folder', () => {
  it('asks for confirmation, then shares them', async () => {
    const refused = await stack.adminCall('POST', '/api/links', { paths: ['Mixed'] });
    expect(refused).toMatchObject({ status: 409, body: { error: 'sensitive', files: ['Mixed/contract.txt'] } });
    const link = await create({ paths: ['Mixed'], confirmSensitive: true });
    expect(link.items[0]?.fileCount).toBe(2);
  });

  it('leaves them out when changes are accepted', async () => {
    const link = await create({ paths: ['Mixed'], confirmSensitive: true });
    write({ 'Mixed/extra.txt': 'extra' });
    const current = (await stack.adminCall('PATCH', `/api/links/${link.id}`, { acceptChanges: true })).body;
    expect(current.items[0]?.fileCount).toBe(2);
    expect((await receive(current)).meta?.entries.map((entry) => entry.path)).toEqual([
      'Mixed/extra.txt',
      'Mixed/ok.txt',
    ]);
  });
});

describe('items and names', () => {
  it('rejects the storage root, denied and missing folders', async () => {
    for (const paths of [[''], ['/'], ['Photos/private'], ['Nope']]) {
      expect((await stack.adminCall('POST', '/api/links', { paths })).status, paths[0]).toBe(400);
    }
  });

  it('drops what was picked inside a folder that is shared as a whole', async () => {
    const link = await create({ paths: ['Photos/a.jpg', 'Photos', 'Photos/2023'] });
    expect(link.items.map((item) => item.path)).toEqual(['Photos']);
  });

  it('skips symbolic links inside a shared folder', async () => {
    write({ 'Links/real.txt': 'real' });
    fs.symlinkSync(path.join(stack.storageRoot, 'Mixed/contract.txt'), path.join(stack.storageRoot, 'Links/alias.txt'));
    fs.symlinkSync(path.join(stack.storageRoot, 'Photos'), path.join(stack.storageRoot, 'Links/photos'));
    const link = await create({ paths: ['Links'], onChange: 'follow' });
    expect((await receive(link)).meta?.entries.map((entry) => entry.path)).toEqual(['Links/real.txt']);
  });

  it('gives items with the same name distinct paths in the archive', async () => {
    write({ 'A/same/x.txt': 'x', 'B/same/y.txt': 'y' });
    const link = await create({ paths: ['A/same', 'B/same'], label: 'Two' });
    const received = await receive(link);
    expect(received.meta?.entries.map((entry) => entry.path)).toEqual(['same/x.txt', 'same (2)/y.txt']);
    expect(received.meta?.bundle?.name).toBe('Two.zip');
  });
});

describe('preferences for new links', () => {
  it('starts from sensible defaults', async () => {
    expect((await stack.adminCall('GET', '/api/preferences')).body).toEqual({
      onChange: 'pause',
      expiryDays: 7,
      maxDownloads: null,
      generatePassword: false,
    });
  });

  it('stores changes and uses the policy for links that do not choose one', async () => {
    const saved = await stack.adminCall('PATCH', '/api/preferences', { onChange: 'follow', maxDownloads: 5 });
    expect(saved.body).toMatchObject({ onChange: 'follow', maxDownloads: 5, expiryDays: 7 });
    expect((await create({ paths: ['Photos'] })).onChange).toBe('follow');
    expect((await create({ paths: ['Photos'], onChange: 'pause' })).onChange).toBe('pause');
  });

  it('rejects values out of range', async () => {
    expect((await stack.adminCall('PATCH', '/api/preferences', { expiryDays: -1 })).status).toBe(400);
    expect((await stack.adminCall('PATCH', '/api/preferences', { onChange: 'ignore' })).status).toBe(400);
  });
});
