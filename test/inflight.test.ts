import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { entryId } from '../src/server/content.ts';
import type { LinkDetail } from '../src/shared/api.ts';
import { startStack } from './stack.ts';

let stack: Awaited<ReturnType<typeof startStack>>;
const BIG = 32 * 1024 * 1024;

beforeAll(async () => {
  stack = await startStack({ 'Work/a.txt': 'aaaa', 'Work/b.txt': 'bbbb' });
});

afterAll(() => stack.close());

const create = async (body: Record<string, unknown>) =>
  (await stack.adminCall('POST', '/api/links', body)).body as LinkDetail;
const detail = async (id: string) => (await stack.adminCall('GET', `/api/links/${id}`)).body as LinkDetail;

const waitFor = async (check: () => Promise<boolean>, what: string) => {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const aborted = async (id: string) => {
  await waitFor(async () => (await detail(id)).events.some((event) => event.type === 'download_aborted'), 'abort');
  return (await detail(id)).events.find((event) => event.type === 'download_aborted');
};

/** Reads the first chunk, runs `during`, then reads on: the bytes that arrived, and whether the stream failed. */
const interrupt = async (body: AsyncIterable<Buffer> & { destroy?: () => void }, during: () => Promise<void>) => {
  let bytes = 0;
  let failed = false;
  try {
    for await (const chunk of body) {
      if (bytes === 0) await during();
      bytes += chunk.length;
    }
  } catch {
    failed = true;
  }
  return { bytes, failed };
};

const bigFile = (name: string) => {
  fs.writeFileSync(path.join(stack.storageRoot, 'Work', name), Buffer.alloc(BIG, 1));
  return `Work/${name}`;
};

describe('a link changed while someone downloads from it', () => {
  it('stops the download when the link is deleted, without taking the process down', async () => {
    const link = await create({ paths: [bigFile('deleted.bin')] });
    const visitor = await stack.visit(link.id, '198.51.100.70');
    const { ticket } = (await stack.open(visitor, link)).json() as { ticket: string };
    const download = await stack.rawDownload(visitor, link.id, entryId(0, ''), ticket);
    expect(download.statusCode).toBe(200);

    const { bytes } = await interrupt(download.body, async () => {
      expect((await stack.adminCall('DELETE', `/api/links/${link.id}`)).status).toBe(204);
    });
    expect(bytes).toBeLessThan(BIG);

    // Still serving: the broker survived recording the end of a download whose link is gone.
    const other = await create({ paths: ['Work/a.txt'] });
    const next = await stack.visit(other.id, '198.51.100.71');
    expect((await stack.open(next, other)).statusCode).toBe(200);
  });

  it.each([
    ['disabled', { active: false }],
    ['password_changed', { password: 'a new password' }],
  ])('stops the download when the link is %s, the zip included', async (reason, patch) => {
    const link = await create({ paths: [bigFile(`${reason}-1.bin`), bigFile(`${reason}-2.bin`)] });
    const visitor = await stack.visit(link.id, '198.51.100.72');
    const { ticket } = (await stack.open(visitor, link)).json() as { ticket: string };
    const download = await stack.rawDownload(visitor, link.id, 'all', ticket);
    expect(download.statusCode).toBe(200);

    const { bytes } = await interrupt(download.body, async () => {
      expect((await stack.adminCall('PATCH', `/api/links/${link.id}`, patch)).status).toBe(200);
    });
    expect(bytes).toBeLessThan(BIG);
    expect((await aborted(link.id))?.detail).toBe(reason);
    expect((await detail(link.id)).counts.downloads).toBe(0);
  });

  it('keeps streaming through an edit that leaves the link open, such as a new label', async () => {
    const link = await create({ paths: ['Work/b.txt', bigFile('relabelled.bin')] });
    const visitor = await stack.visit(link.id, '198.51.100.73');
    const { ticket } = (await stack.open(visitor, link)).json() as { ticket: string };
    const download = await stack.rawDownload(visitor, link.id, entryId(1, ''), ticket);

    const { failed } = await interrupt(download.body, async () => {
      expect((await stack.adminCall('PATCH', `/api/links/${link.id}`, { label: 'Renamed' })).status).toBe(200);
    });
    expect(failed).toBe(false);
    await waitFor(
      async () => (await detail(link.id)).events.some((event) => event.type === 'download_finished'),
      'finish',
    );
  });
});

describe('changes on disk while someone downloads', () => {
  it('leave a download of an untouched file running when something else in the folder changes', async () => {
    fs.mkdirSync(path.join(stack.storageRoot, 'Drift'));
    fs.writeFileSync(path.join(stack.storageRoot, 'Drift/big.bin'), Buffer.alloc(BIG, 3));
    const link = await create({ paths: ['Drift'], onChange: 'pause' });
    const visitor = await stack.visit(link.id, '198.51.100.78');
    const { ticket } = (await stack.open(visitor, link)).json() as { ticket: string };
    const download = await stack.rawDownload(visitor, link.id, entryId(0, 'big.bin'), ticket);
    expect(download.statusCode).toBe(200);

    const { failed } = await interrupt(download.body, async () => {
      fs.writeFileSync(path.join(stack.storageRoot, 'Drift/new.txt'), 'added');
      expect((await stack.adminCall('PATCH', `/api/links/${link.id}`, { label: 'Renamed' })).status).toBe(200);
    });
    expect(failed).toBe(false);
    await waitFor(
      async () => (await detail(link.id)).events.some((event) => event.type === 'download_finished'),
      'finish',
    );
  });
});

describe('a file rewritten while it is being read', () => {
  it('fails the download instead of passing half old and half new bytes as the file', async () => {
    const file = bigFile('rewritten.bin');
    const link = await create({ paths: [file] });
    const visitor = await stack.visit(link.id, '198.51.100.74');
    const { ticket } = (await stack.open(visitor, link)).json() as { ticket: string };
    const download = await stack.rawDownload(visitor, link.id, entryId(0, ''), ticket);

    await interrupt(download.body, async () => {
      // Same size, written in place: only the time tells it apart.
      const fd = fs.openSync(path.join(stack.storageRoot, file), 'r+');
      fs.writeSync(fd, Buffer.alloc(BIG, 2), 0, BIG, 0);
      fs.futimesSync(fd, new Date(), new Date(Date.now() + 5000));
      fs.closeSync(fd);
    });
    // Whether it counts depends on how much was already sent when the file changed, which varies by machine.
    const event = await aborted(link.id);
    expect(event?.detail).toBe('file changed while being read');
  });
});

describe('requests that must not start a download', () => {
  it('answers no HEAD on the files route, which would stream and count everything for nothing', async () => {
    const link = await create({ paths: ['Work/a.txt'], maxDownloads: 1 });
    const visitor = await stack.visit(link.id, '198.51.100.75');
    const { ticket } = (await stack.open(visitor, link)).json() as { ticket: string };
    const head = await stack.edge.inject({
      method: 'HEAD',
      url: `/api/links/${link.id}/files/${entryId(0, '')}`,
      headers: { cookie: visitor.cookie, 'cf-connecting-ip': visitor.ip, 'x-ticket': ticket },
    });
    expect(head.statusCode).toBe(404);
    const current = await detail(link.id);
    expect(current.counts).toMatchObject({ started: 0, downloads: 0 });
    expect(current.state).toBe('active');
  });

  it('tells the visitor nothing about an internal error', async () => {
    const link = await create({ paths: ['Work/a.txt'] });
    const visitor = await stack.visit(link.id, '198.51.100.76');
    const find = stack.shares.find;
    stack.shares.find = () => {
      throw new Error('SQLITE_IOERR on /mnt/storage/private/path');
    };
    try {
      const response = await stack.open(visitor, link);
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('/mnt/storage');
      expect(response.body).not.toContain('SQLITE');
    } finally {
      stack.shares.find = find;
    }
  });
});

describe('pruning old activity', () => {
  it('keeps who already got the files of a link with a limit, so it does not open again', async () => {
    const limited = await create({ paths: ['Work/a.txt'], maxDownloads: 1 });
    const free = await create({ paths: ['Work/b.txt'] });
    for (const link of [limited, free]) {
      const visitor = await stack.visit(link.id, '198.51.100.77');
      const { ticket } = (await stack.open(visitor, link)).json() as { ticket: string };
      const url = `/api/links/${link.id}/files/${entryId(0, '')}`;
      expect((await stack.call(visitor, 'GET', url, undefined, ticket)).statusCode).toBe(200);
    }
    expect((await detail(limited.id)).state).toBe('exhausted');

    await new Promise((resolve) => setTimeout(resolve, 5));
    stack.shares.pruneEvents(0);
    const kept = await detail(limited.id);
    expect(kept.state).toBe('exhausted');
    expect(kept.events.map((event) => event.type)).toEqual(['download_finished']);
    expect(kept.events[0]).toMatchObject({ ip: null, userAgent: null, country: null, language: null });
    expect(kept.events[0]?.visitor).toBeTruthy();
    expect((await detail(free.id)).events).toEqual([]);
  });
});
