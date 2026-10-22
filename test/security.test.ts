import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { entryId } from '../src/server/content.ts';
import type { LinkDetail } from '../src/shared/api.ts';
import { startStack } from './stack.ts';

let stack: Awaited<ReturnType<typeof startStack>>;

beforeAll(async () => {
  stack = await startStack(
    { 'Work/a.txt': 'aaaa', 'Work/b.txt': 'bbbb', 'Work/c.txt': 'cccc', 'Work/d.txt': 'dddd' },
    { MAX_PASSWORD_FAILURES: '3', ADMIN_ALLOW: '127.0.0.1/32,192.168.1.10/32' },
  );
});

afterAll(() => stack.close());

const create = async (body: Record<string, unknown>) =>
  (await stack.adminCall('POST', '/api/links', body)).body as LinkDetail;

describe('admin boundary', () => {
  it('does not let percent-encoded paths skip authentication or the anti-CSRF header', async () => {
    for (const url of ['/%61pi/browse?path=', '/%61pi/links', '/api%2Flinks', '/API/links']) {
      const response = await stack.admin.inject({ method: 'GET', url });
      expect(response.statusCode, url).not.toBe(200);
      expect(response.body).not.toContain('Work');
    }
    const created = await stack.admin.inject({
      method: 'POST',
      url: '/%61pi/links',
      payload: { paths: ['Work/a.txt'] },
    });
    expect(created.statusCode).not.toBe(201);
  });

  it('ignores X-Forwarded-For unless the proxy is trusted', async () => {
    const spoofed = await stack.admin.inject({
      method: 'GET',
      url: '/api/session',
      remoteAddress: '192.168.1.50',
      headers: { 'x-forwarded-for': '192.168.1.10' },
    });
    expect(spoofed.statusCode).toBe(403);
  });

  it('rate-limits logins by the real client address, even with a rotating X-Forwarded-For', async () => {
    const statuses = [];
    for (let i = 0; i < 7; i++) {
      const response = await stack.admin.inject({
        method: 'POST',
        url: '/api/login',
        remoteAddress: '192.168.1.10',
        headers: { 'x-pi-share': '1', 'x-forwarded-for': `10.9.8.${i}` },
        payload: { password: 'wrong' },
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(-2)).toEqual([429, 429]);
  });
});

describe('link id without the key', () => {
  it('opens nothing, logs nothing and cannot lock the link', async () => {
    const link = await create({ paths: ['Work/a.txt'], password: 'secret' });
    const visitor = await stack.visit(link.id);
    const fakeProof = 'A'.repeat(43);
    for (let i = 0; i < 5; i++) {
      const response = await stack.call(visitor, 'POST', `/api/links/${link.id}/unlock`, {
        proof: fakeProof,
        verifier: fakeProof,
      });
      expect(response.statusCode).toBe(404);
    }
    expect((await stack.call(visitor, 'POST', `/api/links/${link.id}/open`, { proof: fakeProof })).statusCode).toBe(
      404,
    );
    const detail = (await stack.adminCall('GET', `/api/links/${link.id}`)).body as LinkDetail;
    expect(detail.state).toBe('active');
    expect(detail.events).toEqual([]);
  });

  it('refuses API calls without the visitor cookie set by the page', async () => {
    const link = await create({ paths: ['Work/a.txt'] });
    const response = await stack.call({ cookie: '', ip: '198.51.100.9' }, 'POST', `/api/links/${link.id}/open`, {
      proof: 'A'.repeat(43),
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('passwords and tickets', () => {
  it('resets the wrong-password counter after a correct password', async () => {
    const link = await create({ paths: ['Work/a.txt'], password: 'secret' });
    const visitor = await stack.visit(link.id, '198.51.100.31');
    for (let round = 0; round < 3; round++) {
      expect((await stack.unlock(visitor, link, 'wrong')).statusCode).toBe(403);
      expect((await stack.unlock(visitor, link, 'wrong')).statusCode).toBe(403);
      expect((await stack.unlock(visitor, link, 'secret')).statusCode).toBe(200);
    }
    expect(((await stack.adminCall('GET', `/api/links/${link.id}`)).body as LinkDetail).state).toBe('active');
  });

  it('does not count a ticket renewal without a password as a wrong password', async () => {
    const link = await create({ paths: ['Work/a.txt'], password: 'secret' });
    const visitor = await stack.visit(link.id, '198.51.100.32');
    for (let i = 0; i < 4; i++) expect((await stack.unlock(visitor, link)).statusCode).toBe(403);
    expect(((await stack.adminCall('GET', `/api/links/${link.id}`)).body as LinkDetail).counts.failedPasswords).toBe(0);
  });

  it('invalidates tickets when the password changes', async () => {
    const link = await create({ paths: ['Work/a.txt'], password: 'secret' });
    const visitor = await stack.visit(link.id, '198.51.100.33');
    const { ticket } = (await stack.unlock(visitor, link, 'secret')).json() as { ticket: string };
    expect(
      (await stack.call(visitor, 'GET', `/api/links/${link.id}/files/${entryId(0, '')}`, undefined, ticket)).statusCode,
    ).toBe(200);
    await stack.adminCall('PATCH', `/api/links/${link.id}`, { password: 'another one' });
    expect(
      (await stack.call(visitor, 'GET', `/api/links/${link.id}/files/${entryId(0, '')}`, undefined, ticket)).statusCode,
    ).toBe(403);
  });

  it('accepts one result per download, only from the visitor holding the ticket', async () => {
    const link = await create({ paths: ['Work/a.txt'] });
    const visitor = await stack.visit(link.id);
    const { ticket } = (await stack.open(visitor, link)).json() as { ticket: string };
    const file = await stack.call(visitor, 'GET', `/api/links/${link.id}/files/${entryId(0, '')}`, undefined, ticket);
    const url = `/api/links/${link.id}/downloads/${file.headers['x-download-id']}/result`;
    const other = await stack.visit(link.id, '198.51.100.2');
    expect((await stack.call(other, 'POST', url, { ok: true }, ticket)).statusCode).toBe(403);
    expect((await stack.call(visitor, 'POST', url, { ok: true }, ticket)).statusCode).toBe(204);
    expect((await stack.call(visitor, 'POST', url, { ok: true }, ticket)).statusCode).toBe(404);
    expect(((await stack.adminCall('GET', `/api/links/${link.id}`)).body as LinkDetail).counts.verified).toBe(1);
  });
});

describe('download limits', () => {
  const detail = async (id: string) => (await stack.adminCall('GET', `/api/links/${id}`)).body as LinkDetail;
  const settled = async (id: string, type: string) => {
    for (let i = 0; i < 100; i++) {
      if ((await detail(id)).events.some((event) => event.type === type)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`no ${type} event`);
  };

  it('does not count a download the recipient cancelled, so it can be retried', async () => {
    fs.writeFileSync(path.join(stack.storageRoot, 'Work/big.bin'), Buffer.alloc(32 * 1024 * 1024, 7));
    const link = await create({ paths: ['Work/big.bin'], maxDownloads: 1 });
    const visitor = await stack.visit(link.id, '198.51.100.60');
    const { ticket } = (await stack.open(visitor, link)).json() as { ticket: string };

    const cancelled = await stack.rawDownload(visitor, link.id, entryId(0, ''), ticket);
    expect(cancelled.statusCode).toBe(200);
    for await (const _chunk of cancelled.body) break;
    await settled(link.id, 'download_aborted');
    let current = await detail(link.id);
    expect(current.counts).toMatchObject({ started: 1, downloads: 0 });
    expect(current.state).toBe('active');

    const retry = await stack.call(visitor, 'GET', `/api/links/${link.id}/files/${entryId(0, '')}`, undefined, ticket);
    expect(retry.statusCode).toBe(200);
    current = await detail(link.id);
    expect(current.counts).toMatchObject({ started: 2, downloads: 1 });
    expect(current.state).toBe('exhausted');
  });

  it('keeps a place in the quota for downloads in flight', async () => {
    const link = await create({ paths: ['Work/big.bin'], maxDownloads: 1 });
    const first = await stack.visit(link.id, '198.51.100.61');
    const second = await stack.visit(link.id, '198.51.100.62');
    const { ticket: firstTicket } = (await stack.open(first, link)).json() as { ticket: string };
    const { ticket: secondTicket } = (await stack.open(second, link)).json() as { ticket: string };
    const url = `/api/links/${link.id}/files/${entryId(0, '')}`;

    const running = await stack.rawDownload(first, link.id, entryId(0, ''), firstTicket);
    expect((await stack.call(second, 'GET', url, undefined, secondTicket)).statusCode).toBe(429);
    running.body.destroy();
    await settled(link.id, 'download_aborted');
    expect((await stack.call(second, 'GET', url, undefined, secondTicket)).statusCode).toBe(200);
  });

  it('counts complete downloads against the limit', async () => {
    const link = await create({ paths: ['Work/b.txt'], maxDownloads: 2 });
    const visitor = await stack.visit(link.id);
    const { ticket } = (await stack.open(visitor, link)).json() as { ticket: string };
    const url = `/api/links/${link.id}/files/${entryId(0, '')}`;
    expect((await stack.call(visitor, 'GET', url, undefined, ticket)).statusCode).toBe(200);
    expect((await stack.call(visitor, 'GET', url, undefined, ticket)).statusCode).toBe(200);
    expect((await stack.call(visitor, 'GET', url, undefined, ticket)).statusCode).toBe(404);
    expect(((await stack.adminCall('GET', `/api/links/${link.id}`)).body as LinkDetail).state).toBe('exhausted');
  });
});

describe('visit logging', () => {
  it('keeps the address and visitor even with oversized headers', async () => {
    const link = await create({ paths: ['Work/c.txt'] });
    const visitor = { ...(await stack.visit(link.id, '192.0.2.77')), userAgent: `Mozilla/5.0 ${'x'.repeat(5000)}` };
    await stack.open(visitor, link);
    const [event] = ((await stack.adminCall('GET', `/api/links/${link.id}`)).body as LinkDetail).events;
    expect(event).toMatchObject({ type: 'open', ip: '192.0.2.77' });
    expect(event?.visitor).toMatch(/^[\w-]{22}$/);
    expect(event?.userAgent?.length).toBeLessThanOrEqual(512);
  });
});

describe('files swapped on disk', () => {
  it('refuses a linked file replaced by a symbolic link after the link was created', async () => {
    const link = await create({ paths: ['Work/d.txt'] });
    const target = path.join(stack.storageRoot, 'Work/d.txt');
    const { mtime, atime } = fs.statSync(target);
    fs.rmSync(target);
    fs.writeFileSync(path.join(stack.root, 'outside.txt'), 'dddd');
    fs.symlinkSync(path.join(stack.root, 'outside.txt'), target);
    fs.lutimesSync(target, atime, mtime);

    const visitor = await stack.visit(link.id);
    const opened = await stack.open(visitor, link);
    if (opened.statusCode === 200) {
      const { ticket } = opened.json() as { ticket: string };
      expect(
        (await stack.call(visitor, 'GET', `/api/links/${link.id}/files/${entryId(0, '')}`, undefined, ticket))
          .statusCode,
      ).toBe(404);
    } else {
      expect(opened.statusCode).toBe(404);
    }
  });
});

describe('parallel wrong passwords', () => {
  it('still lock the link', async () => {
    const link = await create({ paths: ['Work/a.txt'], password: 'secret' });
    const visitors = await Promise.all(
      Array.from({ length: 8 }, (_, i) => stack.visit(link.id, `198.51.100.${100 + i}`)),
    );
    for (let round = 0; round < 3; round++) {
      await Promise.all(visitors.map((visitor) => stack.unlock(visitor, link, 'wrong')));
    }
    expect(((await stack.adminCall('GET', `/api/links/${link.id}`)).body as LinkDetail).state).toBe('locked');
  });
});

describe('files swapped on disk, through a directory', () => {
  it('refuses a file whose parent folder became a symbolic link', async () => {
    fs.mkdirSync(path.join(stack.storageRoot, 'Swap'));
    fs.writeFileSync(path.join(stack.storageRoot, 'Swap/e.txt'), 'eeee');
    const link = await create({ paths: ['Swap/e.txt'] });
    const original = fs.statSync(path.join(stack.storageRoot, 'Swap/e.txt'));
    const outside = path.join(stack.root, 'elsewhere');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'e.txt'), 'eeee');
    fs.utimesSync(path.join(outside, 'e.txt'), original.atime, original.mtime);
    fs.rmSync(path.join(stack.storageRoot, 'Swap'), { recursive: true });
    fs.symlinkSync(outside, path.join(stack.storageRoot, 'Swap'));

    const visitor = await stack.visit(link.id, '198.51.100.60');
    const opened = await stack.open(visitor, link);
    if (opened.statusCode === 200) {
      const { ticket } = opened.json() as { ticket: string };
      expect(
        (await stack.call(visitor, 'GET', `/api/links/${link.id}/files/${entryId(0, '')}`, undefined, ticket))
          .statusCode,
      ).toBe(404);
    } else {
      expect(opened.statusCode).toBe(404);
    }
  });
});
