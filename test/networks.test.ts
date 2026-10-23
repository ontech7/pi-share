import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { entryId } from '../src/server/content.ts';
import { allowList, isAllowed } from '../src/server/network.ts';
import { type LinkDetail, parseNetwork } from '../src/shared/api.ts';
import { startStack } from './stack.ts';

let stack: Awaited<ReturnType<typeof startStack>>;

beforeAll(async () => {
  stack = await startStack({ 'Work/a.txt': 'aaaa' });
});

afterAll(() => stack.close());

const create = async (body: Record<string, unknown>) =>
  (await stack.adminCall('POST', '/api/links', { paths: ['Work/a.txt'], ...body })).body as LinkDetail;

const grant = async (link: LinkDetail, ip: string) => {
  const visitor = await stack.visit(link.id, ip);
  const response = await stack.open(visitor, link);
  return { visitor, response, body: response.json() as { ticket?: string; reason?: string } };
};

describe('network notation', () => {
  it('accepts addresses and ranges in canonical form and rejects the rest', () => {
    expect(parseNetwork(' 203.0.113.7 ')).toBe('203.0.113.7/32');
    expect(parseNetwork('203.0.113.0/24')).toBe('203.0.113.0/24');
    expect(parseNetwork('2001:DB8:0:0::/48')).toBe('2001:db8::/48');
    expect(parseNetwork('2001:db8::1')).toBe('2001:db8::1/128');
    for (const bad of [
      '',
      '256.1.1.1',
      '10.0.0.0/33',
      '2001:db8::/129',
      '10.0.0.0/8/1',
      'example.com',
      '1.2.3',
      'fe80::1%eth0',
      '::/x',
    ])
      expect(parseNetwork(bad), bad).toBeNull();
  });

  it('never lets an empty or garbled client address through a list', () => {
    const list = allowList(['10.0.0.0/8', '2001:db8::/32']);
    expect(isAllowed(list, '10.1.2.3')).toBe(true);
    expect(isAllowed(list, '::ffff:10.1.2.3')).toBe(true);
    expect(isAllowed(list, '2001:db8:1::9')).toBe(true);
    for (const bad of [null, '', 'unknown', '10.1.2.3, 198.51.100.1', '11.0.0.1'])
      expect(isAllowed(list, bad)).toBe(false);
  });
});

describe('links restricted to networks', () => {
  it('stores the networks and rejects invalid ones', async () => {
    const link = await create({ allowedNetworks: ['198.51.100.0/24', '2001:DB8::/32'] });
    expect(link.allowedNetworks).toEqual(['198.51.100.0/24', '2001:db8::/32']);
    const invalid = await stack.adminCall('POST', '/api/links', { paths: ['Work/a.txt'], allowedNetworks: ['nope'] });
    expect(invalid.status).toBe(400);
    const cleared = await stack.adminCall('PATCH', `/api/links/${link.id}`, { allowedNetworks: [] });
    expect(cleared.body.allowedNetworks).toEqual([]);
  });

  it('serves the allowed networks and tells everyone else holding the key why not', async () => {
    const link = await create({ allowedNetworks: ['198.51.100.0/24'] });
    expect((await grant(link, '198.51.100.20')).body.ticket).toBeTruthy();

    const outside = await grant(link, '203.0.113.7');
    expect(outside.response.statusCode).toBe(404);
    expect(outside.body.reason).toBe('network');
    const detail = (await stack.adminCall('GET', `/api/links/${link.id}`)).body as LinkDetail;
    expect(detail.events.find((event) => event.type === 'refused')).toMatchObject({
      detail: 'network',
      ip: '203.0.113.7',
    });
  });

  it('does not reveal the restriction to someone without the key', async () => {
    const link = await create({ allowedNetworks: ['198.51.100.0/24'] });
    const visitor = await stack.visit(link.id, '203.0.113.7');
    const response = await stack.call(visitor, 'POST', `/api/links/${link.id}/open`, { proof: 'x'.repeat(43) });
    expect(response.statusCode).toBe(404);
    expect(response.json().reason).toBeUndefined();
  });

  it('refuses passwords from outside before checking them', async () => {
    const link = await create({ allowedNetworks: ['198.51.100.0/24'], password: 'secret-pass' });
    const visitor = await stack.visit(link.id, '203.0.113.7');
    const response = await stack.unlock(visitor, link, 'wrong-pass');
    expect(response.statusCode).toBe(404);
    expect(response.json().reason).toBe('network');
    const detail = (await stack.adminCall('GET', `/api/links/${link.id}`)).body as LinkDetail;
    expect(detail.counts.failedPasswords).toBe(0);
  });

  it('stops a download when the ticket comes back from another network', async () => {
    const link = await create({ allowedNetworks: ['198.51.100.0/24'] });
    const { visitor, body } = await grant(link, '198.51.100.20');
    const part = entryId(0, '');
    const inside = await stack.call(visitor, 'GET', `/api/links/${link.id}/files/${part}`, undefined, body.ticket);
    expect(inside.statusCode).toBe(200);
    const moved = { ...visitor, ip: '203.0.113.7' };
    const outside = await stack.call(moved, 'GET', `/api/links/${link.id}/files/${part}`, undefined, body.ticket);
    expect(outside.statusCode).toBe(404);
    expect(outside.json().reason).toBe('network');
  });

  it('keeps working for anyone when no network is listed', async () => {
    const link = await create({});
    expect(link.allowedNetworks).toEqual([]);
    expect((await grant(link, '203.0.113.7')).body.ticket).toBeTruthy();
  });
});
