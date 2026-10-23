import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LinkDetail, NotificationSettings } from '../src/shared/api.ts';
import { keyProof } from '../src/shared/wire.ts';
import { startStack } from './stack.ts';

let stack: Awaited<ReturnType<typeof startStack>>;

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const BOT_TOKEN = '123456:AAbbCCddEEffGGhhIIjjKKllMMnn';

beforeAll(async () => {
  stack = await startStack({ 'a.txt': 'aaaa' });
});

afterAll(() => stack.close());

beforeEach(() => {
  stack.sent.length = 0;
  stack.mails.length = 0;
  stack.failNotifications(200);
});

const create = async (body: Record<string, unknown> = {}) =>
  (await stack.adminCall('POST', '/api/links', { paths: ['a.txt'], ...body })).body as LinkDetail;
const configure = (body: Record<string, unknown>) => stack.adminCall('PATCH', '/api/notifications', body);
const messages = () => stack.sent.map((sent) => sent.body as { message: string; priority: number });

describe('notification settings', () => {
  it('start with every channel off', async () => {
    const view = (await stack.adminCall('GET', '/api/notifications')).body as NotificationSettings;
    expect(view.ntfy).toMatchObject({ enabled: false, server: 'https://ntfy.sh', topic: '', hasToken: false });
    expect(view.telegram).toMatchObject({ enabled: false, hasToken: false });
    expect(view.email).toMatchObject({ enabled: false, port: 587, security: 'starttls', hasPassword: false });
  });

  it('refuse to turn on a channel that is not set up', async () => {
    for (const channel of ['ntfy', 'telegram', 'email']) {
      const refused = await configure({ [channel]: { enabled: true } });
      expect(refused, channel).toMatchObject({ status: 400, body: { error: 'incomplete', channel } });
    }
  });

  it('validate what each channel needs', async () => {
    for (const body of [
      { ntfy: { server: 'file:///etc/passwd' } },
      { ntfy: { topic: 'has spaces' } },
      { ntfy: { server: 'https://user:secret@ntfy.example.com' } },
      { ntfy: { server: 'https://ntfy.example.com/?token=x' } },
      { ntfy: { server: 'https://ntfy.example.com/a?' } },
      { telegram: { token: 'not-a-token' } },
      { telegram: { chatId: 'someone' } },
      { email: { host: 'smtp.example.com\r\nRCPT TO:<x@y.z>' } },
      { email: { to: 'not an address' } },
      { email: { port: 70_000 } },
      { email: { password: '   ' } },
    ]) {
      expect((await configure(body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('keep every secret sealed and never hand it back', async () => {
    const saved = await configure({
      ntfy: { server: 'https://ntfy.example.com/', topic: 'pi-share-test_1', token: 'tk_secret' },
      telegram: { token: BOT_TOKEN, chatId: '-1001234' },
      email: {
        host: 'smtp.example.com',
        user: 'me',
        password: 'smtp-secret',
        from: 'pi@example.com',
        to: 'me@example.com',
      },
    });
    expect(saved.status).toBe(200);
    const view = saved.body as NotificationSettings;
    expect([view.ntfy.hasToken, view.telegram.hasToken, view.email.hasPassword]).toEqual([true, true, true]);
    const everything = JSON.stringify(view) + JSON.stringify((await stack.adminCall('GET', '/api/notifications')).body);
    for (const secret of ['tk_secret', BOT_TOKEN, 'smtp-secret']) expect(everything).not.toContain(secret);
  });

  it('send a test on each channel with its own credentials', async () => {
    for (const channel of ['ntfy', 'telegram', 'email'])
      expect((await stack.adminCall('POST', '/api/notifications/test', { channel })).status, channel).toBe(200);
    expect(stack.sent[0]).toMatchObject({
      url: 'https://ntfy.example.com/',
      headers: { authorization: 'Bearer tk_secret' },
      body: { topic: 'pi-share-test_1', title: 'pi-share' },
    });
    expect(stack.sent[1]).toMatchObject({
      url: `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      body: { chat_id: '-1001234' },
    });
    expect(stack.mails[0]).toMatchObject({
      smtp: {
        host: 'smtp.example.com',
        port: 587,
        requireTLS: true,
        secure: false,
        auth: { user: 'me', pass: 'smtp-secret' },
      },
      mail: { from: 'pi@example.com', to: 'me@example.com', subject: 'pi-share · pi-share' },
    });
  });

  it('report why a channel failed as a code, with what the server said but not the secret', async () => {
    const smtpError = Object.assign(new Error('Invalid login: 535 smtp-secret rejected'), {
      code: 'EAUTH',
      response: '535 smtp-secret rejected',
    });
    stack.failNotifications(401, JSON.stringify({ ok: false, description: `Unauthorized ${BOT_TOKEN}` }), smtpError);
    const telegram = await stack.adminCall('POST', '/api/notifications/test', { channel: 'telegram' });
    expect(telegram).toMatchObject({ status: 502, body: { error: 'notify_failed', channel: 'telegram' } });
    expect(telegram.body.detail).toEqual({ code: 'rejected', detail: 'Unauthorized ***' });
    const email = await stack.adminCall('POST', '/api/notifications/test', { channel: 'email' });
    expect(email.body.detail).toEqual({ code: 'auth', detail: '535 *** rejected' });
    stack.failNotifications(404);
    const ntfy = await stack.adminCall('POST', '/api/notifications/test', { channel: 'ntfy' });
    expect(ntfy.body.detail).toEqual({ code: 'status', detail: '404' });
    stack.failNotifications(200, '{}', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNECTION' }));
    const unreachable = await stack.adminCall('POST', '/api/notifications/test', { channel: 'email' });
    expect(unreachable.body.detail).toEqual({ code: 'unreachable', detail: null });
    // A secret the 200-character cut would split in two is still blanked out whole.
    stack.failNotifications(401, JSON.stringify({ ok: false, description: `${'x'.repeat(190)} ${BOT_TOKEN}` }));
    const cut = await stack.adminCall('POST', '/api/notifications/test', { channel: 'telegram' });
    expect(cut.body.detail.detail).not.toContain(BOT_TOKEN.slice(0, 8));
    stack.failNotifications(401, JSON.stringify({ ok: false, description: `Unauthorized ${BOT_TOKEN}` }));
    await stack.adminCall('POST', '/api/notifications/test', { channel: 'telegram' });
    const view = (await stack.adminCall('GET', '/api/notifications')).body as NotificationSettings;
    expect(view.status.telegram.lastError).toEqual({ code: 'rejected', detail: 'Unauthorized ***' });
    expect(JSON.stringify(view)).not.toContain('smtp-secret');
  });

  it('forget a secret on request', async () => {
    const view = (await configure({ ntfy: { token: null } })).body as NotificationSettings;
    expect(view.ntfy.hasToken).toBe(false);
  });
});

describe('saved notification secrets', () => {
  let own: Awaited<ReturnType<typeof startStack>>;
  const testEmail = () => own.adminCall('POST', '/api/notifications/test', { channel: 'email' });

  beforeAll(async () => {
    own = await startStack({ 'a.txt': 'aaaa' });
    own.failNotifications(200);
    await own.adminCall('PATCH', '/api/notifications', {
      email: {
        host: 'smtp.example.com',
        user: 'me',
        password: ' with spaces ',
        from: 'pi@example.com',
        to: 'me@example.com',
      },
    });
  });

  afterAll(() => own.close());

  it('keep the spaces of an SMTP password', async () => {
    expect((await testEmail()).status).toBe(200);
    expect(own.mails.at(-1)?.smtp).toMatchObject({ auth: { user: 'me', pass: ' with spaces ' } });
  });

  it('say so when one can no longer be opened', async () => {
    const stored = own.settings.notifications<{ email: Record<string, unknown> }>();
    if (!stored) throw new Error('no notification settings');
    own.settings.setNotifications({ ...stored, email: { ...stored.email, sealedPassword: 'not-sealed' } });
    expect(await testEmail()).toMatchObject({ status: 502, body: { detail: { code: 'unreadable', detail: null } } });
    const view = (await own.adminCall('GET', '/api/notifications')).body as NotificationSettings;
    expect(view.status.email.lastError).toEqual({ code: 'unreadable', detail: null });
  });
});

describe('notifications about links', () => {
  beforeAll(async () => {
    await configure({
      ntfy: { enabled: true, topic: 'pi-share-test_1', token: null },
      telegram: { enabled: false },
      email: { enabled: false },
      kinds: { opens: true, downloads: true, warnings: true, previews: true },
    });
  });

  it('tell about an open with the browser, but never the link or the address', async () => {
    const link = await create({ label: 'Q3 report' });
    const visitor = {
      ...(await stack.visit(link.id, '203.0.113.7')),
      userAgent: 'Mozilla/5.0 (Macintosh) Chrome/131.0',
    };
    await stack.open(visitor, link);
    await settle();
    expect(stack.sent).toHaveLength(1);
    expect(stack.sent[0]?.body).toMatchObject({ title: 'Q3 report', message: expect.stringContaining('Page opened') });
    expect(stack.sent[0]?.body).toMatchObject({ message: expect.stringContaining('Chrome 131') });
    const everything = JSON.stringify(stack.sent);
    for (const secret of [link.id, link.url.split('#')[1], '203.0.113.7']) expect(everything).not.toContain(secret);
  });

  it('go out on every channel turned on', async () => {
    await configure({ email: { enabled: true } });
    const link = await create({ label: 'Both' });
    await stack.open(await stack.visit(link.id, '198.51.100.40'), link);
    await settle();
    expect(stack.sent).toHaveLength(1);
    expect(stack.mails[0]?.mail).toMatchObject({
      subject: 'pi-share · Both',
      text: expect.stringContaining('Page opened'),
    });
    await configure({ email: { enabled: false } });
  });

  it('say the same thing about the same visitor only once in a while', async () => {
    const link = await create();
    const visitor = await stack.visit(link.id);
    for (let i = 0; i < 3; i++) await stack.open(visitor, link);
    await stack.open(await stack.visit(link.id, '198.51.100.9'), link);
    await settle();
    expect(stack.sent).toHaveLength(2);
  });

  it('warn about attempts from outside the allowed networks and about wrong passwords', async () => {
    const link = await create({ allowedNetworks: ['198.51.100.0/24'] });
    await stack.open(await stack.visit(link.id, '203.0.113.7'), link);
    const locked = await create({ password: 'right-pass' });
    await stack.unlock(await stack.visit(locked.id), locked, 'wrong-pass');
    await settle();
    expect(messages()).toEqual([
      expect.objectContaining({ message: expect.stringContaining('network it does not allow'), priority: 4 }),
      expect.objectContaining({ message: expect.stringContaining('Wrong password'), priority: 4 }),
    ]);
  });

  it('say nothing when a script or a crawler, not a chat app, fetches the link', async () => {
    const link = await create();
    for (const agent of ['curl/8.4.0', 'Googlebot/2.1', 'python-requests/2.31'])
      await stack.edge.inject({ method: 'GET', url: `/d/${link.id}`, headers: { 'user-agent': agent } });
    await settle();
    expect(stack.sent).toHaveLength(0);
  });

  it('call Tor exits Tor and leave unknown places out', async () => {
    const link = await create();
    for (const [country, ip] of [
      ['T1', '198.51.100.61'],
      ['XX', '198.51.100.62'],
    ] as const) {
      const visitor = await stack.visit(link.id, ip);
      await stack.edge.inject({
        method: 'POST',
        url: `/api/links/${link.id}/open`,
        payload: { proof: await keyProof(stack.keyOf(link).key, link.id) },
        headers: { cookie: visitor.cookie, 'cf-connecting-ip': ip, 'cf-ipcountry': country },
      });
    }
    await settle();
    const [tor, unknown] = messages().map((m) => m.message.split('\n')[1] ?? '');
    expect(tor).toMatch(/^Tor/);
    expect(unknown).not.toMatch(/XX|^ /);
  });

  it('name the chat app a link was pasted into', async () => {
    const link = await create();
    await stack.edge.inject({
      method: 'GET',
      url: `/d/${link.id}`,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' },
    });
    await settle();
    expect(stack.sent[0]?.body).toMatchObject({
      message: expect.stringContaining('Link probably pasted into Discord'),
    });
  });

  it('send nothing for kinds turned off, nor once the channel is off', async () => {
    await configure({ kinds: { opens: false } });
    const link = await create();
    await stack.open(await stack.visit(link.id), link);
    await configure({ ntfy: { enabled: false }, kinds: { opens: true } });
    await stack.open(await stack.visit(link.id, '198.51.100.20'), link);
    await settle();
    expect(stack.sent).toHaveLength(0);
  });

  it('keep warnings and other links going when one link floods the budget', async () => {
    await configure({ ntfy: { enabled: true } });
    const busy = await create({ label: 'Busy' });
    for (let i = 0; i < 12; i++) await stack.open(await stack.visit(busy.id, `198.51.100.${100 + i}`), busy);
    const quiet = await create({ label: 'Quiet', password: 'right-pass' });
    await stack.open(await stack.visit(quiet.id, '198.51.100.200'), quiet);
    await stack.unlock(await stack.visit(quiet.id, '198.51.100.201'), quiet, 'wrong-pass');
    await settle();
    const titles = stack.sent.map((sent) => (sent.body as { title: string }).title);
    expect(titles.filter((title) => title === 'Busy')).toHaveLength(5);
    expect(messages().filter((m) => m.message.includes('Wrong password'))).toHaveLength(1);
    expect(titles).toContain('Quiet');
  });

  it('keep the warnings of one link from hiding those of the others', async () => {
    const attacked = await create({ label: 'Attacked', allowedNetworks: ['192.0.2.0/24'] });
    for (let i = 0; i < 15; i++) await stack.open(await stack.visit(attacked.id, `198.51.100.${150 + i}`), attacked);
    const other = await create({ label: 'Other', password: 'right-pass' });
    await stack.unlock(await stack.visit(other.id, '198.51.100.199'), other, 'wrong-pass');
    await settle();
    const titles = stack.sent.map((sent) => (sent.body as { title: string }).title);
    expect(titles.filter((title) => title === 'Attacked')).toHaveLength(10);
    expect(titles).toContain('Other');
  });

  it('never let a failing channel get in the way of a visit', async () => {
    await configure({ ntfy: { enabled: true } });
    stack.failNotifications(500);
    const link = await create();
    const response = await stack.open(await stack.visit(link.id, '198.51.100.30'), link);
    expect(response.statusCode).toBe(200);
  });
});
