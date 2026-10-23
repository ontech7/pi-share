import path from 'node:path';
import { Agent, request } from 'undici';
import { buildAdmin } from '../src/server/admin.ts';
import { buildBroker, TICKET_HEADER, VISIT_HEADER } from '../src/server/broker.ts';
import { loadConfig } from '../src/server/config.ts';
import { loadOrCreateKey, Vault } from '../src/server/crypto.ts';
import { openDatabase } from '../src/server/db/index.ts';
import { buildEdge } from '../src/server/edge.ts';
import { listen } from '../src/server/listen.ts';
import { type Mail, Notifier, type SmtpOptions } from '../src/server/notify.ts';
import { Providers } from '../src/server/providers.ts';
import { SensitiveList } from '../src/server/sensitive.ts';
import { Settings } from '../src/server/settings.ts';
import { Shares } from '../src/server/shares.ts';
import { Storage } from '../src/server/storage.ts';
import { Tokens } from '../src/server/tokens.ts';
import { Updates } from '../src/server/updates.ts';
import type { LinkDetail, ReleaseInfo } from '../src/shared/api.ts';
import { fromBase64Url, keyProof, passwordVerifier } from '../src/shared/wire.ts';
import { tempDir, writeFiles } from './helpers.ts';

export type Visitor = { cookie: string; ip: string; userAgent?: string };

/** Admin, broker (on a unix socket) and edge wired like in production, with an admin session ready. */
/** `providerData` is what the provider download answers: a gzipped iptoasn table. */
export async function startStack(
  files: Record<string, string | Buffer>,
  env: Record<string, string> = {},
  { providerData }: { providerData?: Buffer } = {},
) {
  const root = tempDir();
  const storageRoot = path.join(root, 'storage');
  writeFiles(storageRoot, files);
  const staticRoot = path.join(root, 'static');
  writeFiles(staticRoot, { 'index.html': '<!doctype html><title>share</title>', 'sw.js': '' });
  const sockets = tempDir('ps-');
  const config = loadConfig({
    STORAGE_ROOT: storageRoot,
    DATA_DIR: path.join(root, 'data'),
    PUBLIC_URL: 'https://share.example.com',
    BROKER_LISTEN: `unix:${sockets}/broker.sock`,
    BROKER_URL: `unix:${sockets}/broker.sock`,
    LOG_LEVEL: 'silent',
    ...env,
  });
  const db = openDatabase(config.dbFile);
  const vault = new Vault(loadOrCreateKey(config.masterKeyFile));
  const storage = new Storage(config.storageRoot, config.deny, config.hideSystem, 0);
  const settings = new Settings(db);
  const providers = new Providers({
    file: config.providerFile,
    url: config.providerDataUrl,
    settings,
    enabledDefault: providerData !== undefined,
    userAgent: 'pi-share/test',
    fetch: async () =>
      providerData ? new Response(new Uint8Array(providerData)) : new Response(null, { status: 503 }),
  });
  /** Every notification the stack sends over HTTP (ntfy, Telegram) and by email. */
  const sent: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const mails: { smtp: SmtpOptions; mail: Mail }[] = [];
  let notifyAnswer = { status: 200, body: '{}' };
  let mailError: Error | null = null;
  const failNotifications = (status: number, body = '{}', mail: Error | null = null) => {
    notifyAnswer = { status, body };
    mailError = mail;
  };
  const notifier = new Notifier({
    settings,
    vault,
    providerOf: (ip) => providers.lookup(ip),
    lang: 'en',
    fetch: async (url, init) => {
      sent.push({
        url: String(url),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      });
      return new Response(notifyAnswer.body, { status: notifyAnswer.status });
    },
    mailer: async (smtp, mail) => {
      if (mailError) throw mailError;
      mails.push({ smtp, mail });
    },
  });
  const shares = new Shares({
    db,
    storage,
    vault,
    sensitive: new SensitiveList(config.sensitiveFile),
    publicUrl: config.publicUrl,
    maxPasswordFailures: config.maxPasswordFailures,
    providerOf: (ip) => providers.lookup(ip),
    onEvent: (linkId, event, labelOf) => notifier.onEvent(linkId, event, labelOf),
  });
  await settings.setAdminPassword('correct horse battery');
  // What "GitHub" answers to update checks; tests change it with setRelease.
  let release: ReleaseInfo | null = null;
  const setRelease = (next: ReleaseInfo | null) => {
    release = next;
  };
  const updates = new Updates({
    current: '1.2.3',
    fetchLatest: async () => release,
    settings,
    autoCheckDefault: false,
    requestDir: config.updateRequestDir,
    statusDir: config.updateStatusDir,
  });
  const tokens = new Tokens(db);
  const admin = await buildAdmin({
    config,
    shares,
    settings,
    tokens,
    storage,
    updates,
    providers,
    notifier,
    setupCode: null,
  });
  const broker = buildBroker({ shares, settings, storage, vault, secret: null });
  await listen(broker, config.brokerListen);
  const edge = await buildEdge({ config, brokerSecret: null, staticRoot, onlineCacheMs: 0 });

  const login = await admin.inject({
    method: 'POST',
    url: '/api/login',
    headers: { 'x-pi-share': '1' },
    payload: { password: 'correct horse battery' },
  });
  const cookie = String(login.headers['set-cookie']).split(';')[0] as string;

  const adminCall = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
    const response = await admin.inject({
      method,
      url,
      payload: payload as object,
      headers: { 'x-pi-share': '1', cookie },
    });
    return { status: response.statusCode, body: response.body ? response.json() : null };
  };

  const visit = async (id: string, ip = '203.0.113.7'): Promise<Visitor> => {
    const response = await edge.inject({ method: 'GET', url: `/d/${id}`, headers: { 'cf-connecting-ip': ip } });
    return { cookie: String(response.headers['set-cookie'] ?? '').split(';')[0] as string, ip };
  };

  const call = (visitor: Visitor, method: 'GET' | 'POST', url: string, payload?: unknown, ticket?: string) =>
    edge.inject({
      method,
      url,
      payload: payload as object,
      headers: {
        cookie: visitor.cookie,
        'cf-connecting-ip': visitor.ip,
        'user-agent': visitor.userAgent ?? 'Mozilla/5.0 Chrome/130',
        ...(ticket ? { 'x-ticket': ticket } : {}),
      },
    });

  const keyOf = (link: LinkDetail) => {
    const [base, fragment] = link.url.split('#') as [string, string];
    return { id: base.split('/d/')[1] as string, key: fromBase64Url(fragment) };
  };

  const open = async (visitor: Visitor, link: LinkDetail) => {
    const { id, key } = keyOf(link);
    return call(visitor, 'POST', `/api/links/${id}/open`, { proof: await keyProof(key, id) });
  };

  const unlock = async (visitor: Visitor, link: LinkDetail, password?: string) => {
    const { id, key } = keyOf(link);
    return call(visitor, 'POST', `/api/links/${id}/unlock`, {
      proof: await keyProof(key, id),
      verifier: password === undefined ? undefined : await passwordVerifier(password, key, id),
    });
  };

  const close = () => Promise.all([admin.close(), broker.close(), edge.close()]);

  /** Starts a download straight on the broker socket, so a test can stop reading or hang up midway. */
  const rawDownload = (visitor: Visitor, linkId: string, part: string, ticket: string) =>
    request(`http://localhost/links/${linkId}/files/${part}`, {
      dispatcher: new Agent({ connect: { socketPath: `${sockets}/broker.sock` } }),
      headers: {
        [VISIT_HEADER]: JSON.stringify({ ip: visitor.ip, visitor: visitor.cookie.split('=')[1] }),
        [TICKET_HEADER]: ticket,
      },
    });

  return {
    root,
    storageRoot,
    admin,
    edge,
    shares,
    providers,
    settings,
    sent,
    mails,
    failNotifications,
    adminCall,
    visit,
    call,
    open,
    unlock,
    keyOf,
    rawDownload,
    setRelease,
    close,
  };
}
