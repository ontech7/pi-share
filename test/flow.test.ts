import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAdmin } from '../src/server/admin.ts';
import { buildBroker } from '../src/server/broker.ts';
import { loadConfig } from '../src/server/config.ts';
import { entryId } from '../src/server/content.ts';
import { loadOrCreateKey, Vault } from '../src/server/crypto.ts';
import { openDatabase } from '../src/server/db/index.ts';
import { buildEdge } from '../src/server/edge.ts';
import { listen } from '../src/server/listen.ts';
import { Notifier } from '../src/server/notify.ts';
import { Providers } from '../src/server/providers.ts';
import { SensitiveList } from '../src/server/sensitive.ts';
import { Settings } from '../src/server/settings.ts';
import { Shares } from '../src/server/shares.ts';
import { Storage } from '../src/server/storage.ts';
import { Updates } from '../src/server/updates.ts';
import type { LinkDetail, ShareMeta } from '../src/shared/api.ts';
import { decryptStream, fromBase64Url, keyProof, openMeta, passwordVerifier, type Sealed } from '../src/shared/wire.ts';
import { tempDir, writeFiles } from './helpers.ts';

const SETUP_CODE = 'ABCDE-12345';
const ADMIN_PASSWORD = 'correct horse battery';
const report = crypto.randomBytes(150_000);
const csrf = { 'x-pi-share': '1' };

let root: string;
let admin: FastifyInstance;
let broker: FastifyInstance;
let edge: FastifyInstance;
let shares: Shares;
let cookie = '';

const adminCall = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
  const response = await admin.inject({ method, url, payload: payload as object, headers: { ...csrf, cookie } });
  return { status: response.statusCode, body: response.body ? response.json() : null };
};

type Visitor = { cookie: string; ip: string };

async function visit(id: string, visitor: Partial<Visitor> = {}): Promise<Visitor> {
  const response = await edge.inject({
    method: 'GET',
    url: `/d/${id}`,
    headers: { 'cf-connecting-ip': visitor.ip ?? '203.0.113.7', 'user-agent': 'Mozilla/5.0 Chrome/130' },
  });
  expect(response.statusCode).toBe(200);
  const setCookie = String(response.headers['set-cookie'] ?? '');
  return { cookie: setCookie.split(';')[0] as string, ip: visitor.ip ?? '203.0.113.7' };
}

const edgeCall = (visitor: Visitor, method: 'GET' | 'POST', url: string, payload?: unknown, ticket?: string) =>
  edge.inject({
    method,
    url,
    payload: payload as object,
    headers: {
      cookie: visitor.cookie,
      'cf-connecting-ip': visitor.ip,
      'cf-ipcountry': 'IT',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130',
      'accept-language': 'it-IT,it;q=0.9',
      ...(ticket ? { 'x-ticket': ticket } : {}),
    },
  });

async function decrypt(body: Buffer, key: Uint8Array<ArrayBuffer>, id: string, part: string) {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(body));
      controller.close();
    },
  });
  return Buffer.from(await new Response(source.pipeThrough(decryptStream(key, id, part))).arrayBuffer());
}

const parseLink = (url: string) => {
  const [base, fragment] = url.split('#') as [string, string];
  return { id: base.split('/d/')[1] as string, key: fromBase64Url(fragment) };
};

const openCall = async (visitor: Visitor, link: LinkDetail) => {
  const { id, key } = parseLink(link.url);
  return edgeCall(visitor, 'POST', `/api/links/${id}/open`, { proof: await keyProof(key, id) });
};

const unlockCall = async (visitor: Visitor, link: LinkDetail, password?: string) => {
  const { id, key } = parseLink(link.url);
  return edgeCall(visitor, 'POST', `/api/links/${id}/unlock`, {
    proof: await keyProof(key, id),
    verifier: password === undefined ? undefined : await passwordVerifier(password, key, id),
  });
};

beforeAll(async () => {
  root = tempDir();
  const storageRoot = path.join(root, 'storage');
  writeFiles(storageRoot, { 'Work/report.bin': report, 'Work/notes.txt': 'hello', 'Private/secret.txt': 'no' });
  const staticRoot = path.join(root, 'static');
  writeFiles(staticRoot, { 'index.html': '<!doctype html><title>share</title>', 'sw.js': '' });

  const sockets = tempDir('ps-');
  const config = loadConfig({
    STORAGE_ROOT: storageRoot,
    DATA_DIR: path.join(root, 'data'),
    PUBLIC_URL: 'https://share.example.com',
    BROKER_LISTEN: `unix:${sockets}/broker.sock`,
    BROKER_URL: `unix:${sockets}/broker.sock`,
    DENY_PATHS: 'Private',
    MAX_PASSWORD_FAILURES: '3',
    LOG_LEVEL: 'silent',
  });
  const db = openDatabase(config.dbFile);
  const vault = new Vault(loadOrCreateKey(config.masterKeyFile));
  const storage = new Storage(config.storageRoot, config.deny, config.hideSystem);
  const settings = new Settings(db);
  shares = new Shares({
    db,
    storage,
    vault,
    sensitive: new SensitiveList(''),
    publicUrl: config.publicUrl,
    maxPasswordFailures: config.maxPasswordFailures,
  });
  const updates = new Updates({
    current: '1.0.0',
    fetchLatest: async () => null,
    settings,
    autoCheckDefault: false,
    requestDir: '',
    statusDir: '',
  });
  const providers = new Providers({
    file: config.providerFile,
    url: config.providerDataUrl,
    settings,
    enabledDefault: false,
    userAgent: 'pi-share/test',
  });
  const notifier = new Notifier({ settings, vault, providerOf: () => null, lang: 'en' });
  admin = await buildAdmin({ config, shares, settings, storage, updates, providers, notifier, setupCode: SETUP_CODE });
  broker = buildBroker({ shares, settings, storage, vault, secret: null });
  await listen(broker, config.brokerListen);
  edge = await buildEdge({ config, brokerSecret: null, staticRoot, onlineCacheMs: 0 });
});

afterAll(async () => {
  await Promise.all([admin?.close(), broker?.close(), edge?.close()]);
});

describe('admin access', () => {
  it('needs the setup code once, then the password', async () => {
    expect((await adminCall('GET', '/api/session')).body).toMatchObject({ authenticated: false, needsSetup: true });
    expect((await adminCall('GET', '/api/links')).status).toBe(401);
    expect((await adminCall('POST', '/api/setup', { code: 'WRONG-00000', password: ADMIN_PASSWORD })).status).toBe(403);

    const setup = await admin.inject({
      method: 'POST',
      url: '/api/setup',
      headers: csrf,
      payload: { code: SETUP_CODE.toLowerCase(), password: ADMIN_PASSWORD },
    });
    expect(setup.statusCode).toBe(200);
    cookie = String(setup.headers['set-cookie']).split(';')[0] as string;
    expect(String(setup.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict/);

    expect((await adminCall('POST', '/api/setup', { code: SETUP_CODE, password: ADMIN_PASSWORD })).status).toBe(409);
    expect((await adminCall('GET', '/api/session')).body).toMatchObject({ authenticated: true, needsSetup: false });
  });

  it('rejects writes without the anti-CSRF header and clients outside the allowed networks', async () => {
    const noHeader = await admin.inject({ method: 'POST', url: '/api/logout', headers: { cookie } });
    expect(noHeader.statusCode).toBe(403);
    const outside = await admin.inject({ method: 'GET', url: '/api/session', remoteAddress: '8.8.8.8' });
    expect(outside.statusCode).toBe(403);
  });

  it('browses the storage without showing denied folders', async () => {
    const { body } = await adminCall('GET', '/api/browse?path=');
    expect(body.entries.map((entry: { name: string }) => entry.name)).toEqual(['Work']);
    expect((await adminCall('GET', '/api/browse?path=Private')).status).toBe(400);
    expect((await adminCall('POST', '/api/links', { paths: ['Private/secret.txt'] })).status).toBe(400);
  });
});

describe('sharing flow', () => {
  const first = entryId(0, '');
  const second = entryId(1, '');
  let link: LinkDetail;
  let key: Uint8Array<ArrayBuffer>;

  it('creates a password-protected link with two files', async () => {
    const created = await adminCall('POST', '/api/links', {
      paths: ['Work/report.bin', 'Work/notes.txt'],
      label: 'Q3 report',
      password: 'open sesame',
    });
    expect(created.status).toBe(201);
    link = created.body;
    expect(link.state).toBe('active');
    expect(link.url).toMatch(/^https:\/\/share\.example\.com\/d\/[\w-]+#[\w-]{43}$/);
    key = parseLink(link.url).key;
  });

  it('serves nothing about the files before the password', async () => {
    const visitor = await visit(link.id);
    const open = await openCall(visitor, link);
    expect(open.json()).toEqual({ passwordRequired: true });
    const sneaky = await edgeCall(visitor, 'GET', `/api/links/${link.id}/files/${first}`);
    expect(sneaky.statusCode).toBe(403);
  });

  it('downloads, decrypts and verifies each file and the zip', async () => {
    const visitor = await visit(link.id);
    await openCall(visitor, link);
    const wrong = await unlockCall(visitor, link, 'nope');
    expect(wrong.statusCode).toBe(403);

    const unlock = await unlockCall(visitor, link, 'open sesame');
    expect(unlock.statusCode).toBe(200);
    const { meta, ticket } = unlock.json() as { meta: Sealed; ticket: string };
    const shareMeta = await openMeta<ShareMeta>(key, link.id, meta);
    expect(shareMeta.entries).toEqual([
      { id: first, path: 'report.bin', size: report.length },
      { id: second, path: 'notes.txt', size: 5 },
    ]);
    expect(shareMeta.bundle?.name).toBe('Q3 report.zip');

    const file = await edgeCall(visitor, 'GET', `/api/links/${link.id}/files/${first}`, undefined, ticket);
    expect(file.statusCode).toBe(200);
    expect(Number(file.headers['content-length'])).toBe(file.rawPayload.length);
    expect(await decrypt(file.rawPayload, key, link.id, first)).toEqual(report);
    const downloadId = String(file.headers['x-download-id']);
    const result = await edgeCall(
      visitor,
      'POST',
      `/api/links/${link.id}/downloads/${downloadId}/result`,
      { ok: true },
      ticket,
    );
    expect(result.statusCode).toBe(204);

    const zip = await edgeCall(visitor, 'GET', `/api/links/${link.id}/files/all`, undefined, ticket);
    const archive = await decrypt(zip.rawPayload, key, link.id, 'all');
    expect(archive.length).toBe(shareMeta.bundle?.size);
    const zipFile = path.join(root, 'bundle.zip');
    fs.writeFileSync(zipFile, archive);
    expect(execFileSync('unzip', ['-t', zipFile]).toString()).toContain('No errors detected');

    const otherVisitor = await visit(link.id, { ip: '198.51.100.1' });
    const stolen = await edgeCall(otherVisitor, 'GET', `/api/links/${link.id}/files/${first}`, undefined, ticket);
    expect(stolen.statusCode).toBe(403);
  });

  it('reports opens, downloads and visitors to the admin', async () => {
    const { body } = await adminCall('GET', `/api/links/${link.id}`);
    expect(body.counts).toEqual({
      opens: 2,
      started: 2,
      downloads: 2,
      recipients: 1,
      verified: 1,
      visitors: 2,
      failedPasswords: 1,
    });
    const started = body.events.find((event: { type: string }) => event.type === 'download_started');
    expect(started).toMatchObject({ ip: '203.0.113.7', country: 'IT', language: 'it-IT,it;q=0.9' });
    expect(started.userAgent).toContain('Windows');
  });

  it('logs link previews from chat apps separately', async () => {
    await edge.inject({
      method: 'GET',
      url: `/d/${link.id}`,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0)' },
    });
    const { body } = await adminCall('GET', `/api/links/${link.id}`);
    expect(body.events[0].type).toBe('preview');
    expect(body.counts.opens).toBe(2);
  });

  it('stops serving a disabled link and serves it again once re-enabled', async () => {
    const visitor = await visit(link.id);
    await adminCall('PATCH', `/api/links/${link.id}`, { active: false });
    expect((await openCall(visitor, link)).statusCode).toBe(404);
    await adminCall('PATCH', `/api/links/${link.id}`, { active: true });
    expect((await openCall(visitor, link)).statusCode).toBe(200);
  });

  it('locks the link after too many wrong passwords', async () => {
    const visitor = await visit(link.id, { ip: '192.0.2.50' });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await unlockCall(visitor, link, 'wrong')).statusCode);
    expect(statuses).toEqual([403, 403, 404]);
    expect((await adminCall('GET', `/api/links/${link.id}`)).body.state).toBe('locked');
    await adminCall('PATCH', `/api/links/${link.id}`, { active: true });
    expect((await adminCall('GET', `/api/links/${link.id}`)).body.state).toBe('active');
  });

  it('pauses the whole link when a file changes, until the change is accepted', async () => {
    const storageRoot = path.join(root, 'storage');
    const visitor = await visit(link.id);
    await openCall(visitor, link);
    const { ticket } = (await unlockCall(visitor, link, 'open sesame')).json() as { ticket: string };

    fs.writeFileSync(path.join(storageRoot, 'Work/notes.txt'), 'changed!');
    let detail = (await adminCall('GET', `/api/links/${link.id}`)).body as LinkDetail;
    expect(detail.state).toBe('paused');
    expect(detail.items.map((item) => item.state)).toEqual(['ok', 'changed']);
    expect(detail.changes).toEqual([{ path: 'notes.txt', change: 'changed' }]);

    const refused = await openCall(visitor, link);
    expect(refused.statusCode).toBe(404);
    expect(refused.json()).toEqual({ error: 'unavailable', reason: 'paused' });
    expect((await edgeCall(visitor, 'GET', `/api/links/${link.id}/files/${first}`, undefined, ticket)).statusCode).toBe(
      404,
    );

    await adminCall('PATCH', `/api/links/${link.id}`, { acceptChanges: detail.version });
    detail = (await adminCall('GET', `/api/links/${link.id}`)).body;
    expect(detail.state).toBe('active');
    expect(detail.items.map((item) => item.state)).toEqual(['ok', 'ok']);
    expect(detail.items[1]?.size).toBe(8);

    fs.rmSync(path.join(storageRoot, 'Work/report.bin'));
    fs.rmSync(path.join(storageRoot, 'Work/notes.txt'));
    detail = (await adminCall('GET', `/api/links/${link.id}`)).body;
    expect(detail.state).toBe('unavailable');
  });
});

describe('service switch', () => {
  it('answers 404 to everything when switched off, and when no link is active with auto-off', async () => {
    const { body: created } = await adminCall('POST', '/api/links', { paths: ['Work/report.bin'] }).catch(() => ({
      body: null,
    }));
    expect(created).toMatchObject({ error: 'file_not_found' });

    writeFiles(path.join(root, 'storage'), { 'Work/again.txt': 'again' });
    const { body: link } = await adminCall('POST', '/api/links', { paths: ['Work/again.txt'] });
    const visitor = await visit(link.id);

    expect((await adminCall('PATCH', '/api/service', { enabled: false })).body).toMatchObject({ enabled: false });
    expect((await edge.inject({ method: 'GET', url: `/d/${link.id}` })).statusCode).toBe(404);
    expect((await openCall(visitor, link)).statusCode).toBe(404);
    expect((await edge.inject({ method: 'GET', url: '/sw.js' })).statusCode).toBe(404);

    await adminCall('PATCH', '/api/service', { enabled: true, autoOff: true });
    expect((await edge.inject({ method: 'GET', url: `/d/${link.id}` })).statusCode).toBe(200);
    await adminCall('DELETE', `/api/links/${link.id}`);
    expect((await adminCall('GET', '/api/service')).body).toMatchObject({ online: false, activeLinks: 0 });
    expect((await edge.inject({ method: 'GET', url: '/sw.js' })).statusCode).toBe(404);
  });
});
