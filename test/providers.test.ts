import fs from 'node:fs';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseTable } from '../src/server/providers.ts';
import type { LinkDetail, ProviderInfo } from '../src/shared/api.ts';
import { startStack } from './stack.ts';

/** A small iptoasn-style table, padded past the minimum a download must have to be trusted. */
function table(extra: string[] = []): Buffer {
  const rows = [
    '1.0.0.0\t1.0.0.255\t13335\tUS\tCLOUDFLARENET',
    '1.0.1.0\t1.0.3.255\t0\tNone\tNot routed',
    '2.32.0.0\t2.47.255.255\t30722\tIT\tVODAFONE-IT-ASN Vodafone Italia S.p.A.',
    '35.196.0.0\t35.199.255.255\t396982\tUS\tGOOGLE-CLOUD-PLATFORM',
    '2001:4bb8::\t2001:4bbf:ffff:ffff:ffff:ffff:ffff:ffff\t8447\tAT\tA1TELEKOM-AT A1 Telekom Austria AG',
    'not\ta\tline',
    '9.9.9.9\t9.9.9.0\t19281\tUS\treversed range',
    '10.0.0.0\t10.0.0.255\tx\tUS\tbad asn',
    `11.0.0.0\t11.0.0.255\t64500\tUS\tEVIL ${'\u0007'}Name${'x'.repeat(300)}`,
    ...extra,
  ];
  for (let i = 0; i < 1_000; i++)
    rows.push(`100.${i >> 8}.${i & 255}.0\t100.${i >> 8}.${i & 255}.255\t64512\tZZ\tFILLER`);
  return zlib.gzipSync(rows.join('\n'));
}

describe('provider table', () => {
  it('finds IPv4 and IPv6 ranges, prettifies names and marks hosting networks', async () => {
    const parsed = await parseTable(Readable.from([table()]));
    expect(parsed.lookup('2001:4bb8:147:97a0:8401:58c7:d6d7:c2ba')).toEqual({
      asn: 8447,
      name: 'A1 Telekom Austria AG',
      hosting: false,
    });
    expect(parsed.lookup('2.34.40.138')).toMatchObject({ asn: 30722, name: 'Vodafone Italia S.p.A.' });
    expect(parsed.lookup('::ffff:35.196.132.85')).toMatchObject({ asn: 396982, hosting: true });
    expect(parsed.lookup('1.0.0.1')).toMatchObject({ name: 'CLOUDFLARENET', hosting: true });
  });

  it('skips unrouted, malformed and reversed rows and cuts names to size', async () => {
    const parsed = await parseTable(Readable.from([table()]));
    for (const ip of ['1.0.2.1', '9.9.9.9', '10.0.0.1', '192.0.2.1', 'unknown', '', null])
      expect(parsed.lookup(ip)).toBeNull();
    const evil = parsed.lookup('11.0.0.1');
    expect(evil?.name).not.toMatch(/\p{C}/u);
    expect(evil?.name.length).toBeLessThanOrEqual(100);
  });

  it('refuses a table built to exhaust memory or CPU', async () => {
    const rows = zlib.gzipSync('1::\t1::\t1\n'.repeat(2_000_001));
    await expect(parseTable(Readable.from([rows]))).rejects.toMatchObject({ code: 'invalid', detail: null });
    // Refused halfway, the source is closed too: a file read from disk does not stay open.
    const line = Readable.from([zlib.gzipSync('x'.repeat(100_000))]);
    await expect(parseTable(line)).rejects.toMatchObject({ code: 'invalid', detail: null });
    await new Promise((resolve) => setImmediate(resolve));
    expect(line.destroyed).toBe(true);
  });

  it('reads a table that is already in order, as iptoasn publishes it', async () => {
    const rows = [
      '1.0.0.0\t1.0.0.255\t13335\tUS\tCLOUDFLARENET',
      '2.32.0.0\t2.47.255.255\t30722\tIT\tVODAFONE-IT-ASN Vodafone Italia S.p.A.',
      '35.196.0.0\t35.199.255.255\t396982\tUS\tGOOGLE-CLOUD-PLATFORM',
      '2001:4bb8::\t2001:4bbf:ffff:ffff:ffff:ffff:ffff:ffff\t8447\tAT\tA1TELEKOM-AT A1 Telekom Austria AG',
    ];
    const parsed = await parseTable(Readable.from([zlib.gzipSync(rows.join('\n'))]));
    expect(parsed.size).toBe(4);
    expect(parsed.lookup('1.0.0.1')?.asn).toBe(13335);
    expect(parsed.lookup('2.34.40.138')?.asn).toBe(30722);
    expect(parsed.lookup('35.199.0.1')?.asn).toBe(396982);
    expect(parsed.lookup('2001:4bb8::1')?.asn).toBe(8447);
    expect(parsed.lookup('3.0.0.1')).toBeNull();
  });

  it('rejects data that is not gzip', async () => {
    await expect(parseTable(Readable.from([Buffer.from('plain text')]))).rejects.toThrow();
  });
});

describe('providers in the activity', () => {
  let stack: Awaited<ReturnType<typeof startStack>>;

  beforeAll(async () => {
    stack = await startStack({ 'a.txt': 'aaaa' }, {}, { providerData: table() });
  });

  afterAll(() => stack.close());

  it('downloads the table, keeps it on disk and names the provider of each visit', async () => {
    await stack.providers.start();
    const info = (await stack.adminCall('GET', '/api/providers')).body as ProviderInfo;
    expect(info).toMatchObject({ enabled: true, error: null, updating: false });
    expect(info.ranges).toBeGreaterThan(1_000);
    expect(fs.existsSync(`${stack.root}/data/ip2asn.tsv.gz`)).toBe(true);

    const link = (await stack.adminCall('POST', '/api/links', { paths: ['a.txt'] })).body as LinkDetail;
    await stack.open(await stack.visit(link.id, '2001:4bb8:147:97a0::1'), link);
    const detail = (await stack.adminCall('GET', `/api/links/${link.id}`)).body as LinkDetail;
    expect(detail.events[0]?.provider).toEqual({ asn: 8447, name: 'A1 Telekom Austria AG', hosting: false });
  });

  it('stops naming providers when turned off', async () => {
    const off = (await stack.adminCall('PATCH', '/api/providers', { enabled: false })).body as ProviderInfo;
    expect(off.enabled).toBe(false);
    const link = (await stack.adminCall('POST', '/api/links', { paths: ['a.txt'] })).body as LinkDetail;
    await stack.open(await stack.visit(link.id, '2001:4bb8:147:97a0::1'), link);
    const detail = (await stack.adminCall('GET', `/api/links/${link.id}`)).body as LinkDetail;
    expect(detail.events[0]?.provider).toBeNull();
    await stack.adminCall('PATCH', '/api/providers', { enabled: true });
  });
});

describe('a bad provider download', () => {
  let stack: Awaited<ReturnType<typeof startStack>>;

  beforeAll(async () => {
    stack = await startStack(
      { 'a.txt': 'aaaa' },
      {},
      { providerData: zlib.gzipSync('1.0.0.0\t1.0.0.255\t13335\tUS\tX') },
    );
  });

  afterAll(() => stack.close());

  it('keeps no table and reports why', async () => {
    await stack.providers.start();
    const info = stack.providers.info();
    expect(info.ranges).toBe(0);
    expect(info.error).toEqual({ code: 'invalid', detail: null });
    expect(fs.existsSync(`${stack.root}/data/ip2asn.tsv.gz`)).toBe(false);
  });
});

describe('provider table lifecycle', () => {
  let stack: Awaited<ReturnType<typeof startStack>>;

  beforeAll(async () => {
    stack = await startStack({ 'a.txt': 'aaaa' }, {}, { providerData: table() });
  });

  afterAll(() => stack.close());

  it('never lets the older table on disk replace a newer download', async () => {
    const stale = table(['2001:4bb8::\t2001:4bbf:ffff:ffff:ffff:ffff:ffff:ffff\t64999\tAT\tSTALE Old Name']);
    fs.mkdirSync(`${stack.root}/data`, { recursive: true });
    fs.writeFileSync(`${stack.root}/data/ip2asn.tsv.gz`, stale);
    fs.utimesSync(`${stack.root}/data/ip2asn.tsv.gz`, new Date(0), new Date(0));
    await Promise.all([stack.providers.start(), stack.providers.refresh()]);
    expect(stack.providers.lookup('2001:4bb8::1')?.asn).toBe(8447);
  });

  it('lets the table go when turned off and loads it back when turned on', async () => {
    stack.providers.setEnabled(false);
    expect(stack.providers.info()).toMatchObject({ enabled: false, ranges: 0 });
    await stack.providers.start();
    expect(stack.providers.info().ranges).toBe(0);
    const before = fs.statSync(`${stack.root}/data/ip2asn.tsv.gz`).mtimeMs;
    const refused = (await stack.adminCall('POST', '/api/providers/refresh')).body as ProviderInfo;
    expect(refused).toMatchObject({ enabled: false, updating: false });
    expect(fs.statSync(`${stack.root}/data/ip2asn.tsv.gz`).mtimeMs).toBe(before);
    // The page polls only while the state says it is updating: it has to from the answer that turns it on.
    const on = (await stack.adminCall('PATCH', '/api/providers', { enabled: true })).body as ProviderInfo;
    expect(on).toMatchObject({ enabled: true, updating: true });
    await stack.providers.start();
    expect(stack.providers.lookup('2001:4bb8::1')?.asn).toBe(8447);
  });
});
