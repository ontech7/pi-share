import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedToken, LinkDetail, LinkSummary, TokenView } from '../src/shared/api.ts';
import { startStack } from './stack.ts';

let stack: Awaited<ReturnType<typeof startStack>>;

beforeAll(async () => {
  stack = await startStack(
    { 'Work/photo.jpg': 'jpeg', 'Work/notes.txt': 'notes', 'Private/diary.txt': 'diary' },
    { ADMIN_ALLOW: '127.0.0.1/32' },
  );
});

afterAll(() => stack.close());

const DAY = 86_400_000;

const newToken = async (name = 'pi-agent', expiresAt: number | null = Date.now() + 30 * DAY) => {
  const response = await stack.adminCall('POST', '/api/tokens', { name, expiresAt });
  expect(response.status).toBe(201);
  return response.body as CreatedToken;
};

const withToken = async (
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) => {
  const response = await stack.admin.inject({
    method,
    url,
    payload: payload as object,
    headers: { authorization: `Bearer ${token}`, ...headers },
  });
  return { status: response.statusCode, body: response.body ? response.json() : null };
};

describe('integration tokens', () => {
  it('shows the token once and keeps only a hint of it', async () => {
    const created = await newToken();
    expect(created.token).toMatch(/^pis_[\w-]{43}$/);
    expect(created.hint).toBe(created.token.slice(-4));

    const list = (await stack.adminCall('GET', '/api/tokens')).body as TokenView[];
    const listed = list.find((token) => token.id === created.id);
    expect(listed).toMatchObject({ name: 'pi-agent', hint: created.hint, lastUsedAt: null });
    expect(JSON.stringify(list)).not.toContain(created.token);
    expect(JSON.stringify(list)).not.toContain('tokenHash');
  });

  it('creates a link with the saved defaults for what it leaves out, without the anti-CSRF header', async () => {
    await stack.adminCall('PATCH', '/api/preferences', { expiryDays: 30, maxDownloads: 3, onChange: 'follow' });
    const { token, id } = await newToken('agent defaults');
    const before = Date.now();
    const response = await withToken(token, 'POST', '/api/links', { paths: ['Work/photo.jpg'], password: '1234' });
    expect(response.status).toBe(201);
    const link = response.body as LinkDetail;
    expect(link).toMatchObject({ hasPassword: true, maxDownloads: 3, onChange: 'follow', createdBy: 'agent defaults' });
    expect(link.expiresAt).toBeGreaterThanOrEqual(before + 30 * DAY);
    expect(link.expiresAt).toBeLessThanOrEqual(Date.now() + 30 * DAY);
    expect(link.url).toMatch(/^https:\/\/share\.example\.com\/d\/[\w-]+#[\w-]{43}$/);

    const tokens = (await stack.adminCall('GET', '/api/tokens')).body as TokenView[];
    expect(tokens.find((entry) => entry.id === id)?.lastUsedAt).toBeGreaterThanOrEqual(before);
    await stack.adminCall('PATCH', '/api/preferences', { expiryDays: 7, maxDownloads: null, onChange: 'pause' });
  });

  it('keeps explicit values, null included, over the defaults', async () => {
    const { token } = await newToken('explicit');
    const link = (
      await withToken(token, 'POST', '/api/links', { paths: ['Work/notes.txt'], expiresAt: null, maxDownloads: 5 })
    ).body as LinkDetail;
    expect(link).toMatchObject({ expiresAt: null, maxDownloads: 5, hasPassword: false });
  });

  it('sees, reads and deletes only the links it created', async () => {
    const mine = await newToken('mine');
    const other = await newToken('other');
    const byHand = (await stack.adminCall('POST', '/api/links', { paths: ['Private/diary.txt'] })).body as LinkDetail;
    expect(byHand.createdBy).toBeNull();
    const own = (await withToken(mine.token, 'POST', '/api/links', { paths: ['Work/notes.txt'] })).body as LinkDetail;

    const listed = (await withToken(mine.token, 'GET', '/api/links')).body as LinkSummary[];
    expect(listed.map((link) => link.id)).toEqual([own.id]);
    expect((await withToken(other.token, 'GET', '/api/links')).body).toEqual([]);

    for (const id of [byHand.id, own.id]) {
      const token = id === own.id ? other.token : mine.token;
      expect((await withToken(token, 'GET', `/api/links/${id}`)).status).toBe(404);
      expect((await withToken(token, 'DELETE', `/api/links/${id}`)).status).toBe(404);
    }
    expect((await stack.adminCall('GET', `/api/links/${byHand.id}`)).status).toBe(200);

    expect((await withToken(mine.token, 'GET', `/api/links/${own.id}`)).body).toMatchObject({ url: own.url });
    expect((await withToken(mine.token, 'DELETE', `/api/links/${own.id}`)).status).toBe(204);
    expect((await stack.adminCall('GET', `/api/links/${own.id}`)).status).toBe(404);
  });

  it('may do nothing but links', async () => {
    const { token } = await newToken('scoped');
    const link = (await withToken(token, 'POST', '/api/links', { paths: ['Work/notes.txt'] })).body as LinkDetail;
    const refused: [method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown][] = [
      ['GET', '/api/tokens'],
      ['POST', '/api/tokens', { name: 'escalate', expiresAt: null }],
      ['PATCH', `/api/links/${link.id}`, { active: true }],
      ['GET', '/api/browse?path='],
      ['GET', '/api/preferences'],
      ['PATCH', '/api/service', { enabled: false }],
      ['POST', '/api/updates/install', { version: '9.9.9' }],
      ['POST', '/api/password', { current: 'x', password: 'xxxxxxxxxxxx' }],
      ['POST', '/api/logout'],
      ['GET', '/api/session'],
    ];
    for (const [method, url, payload] of refused) {
      const response = await withToken(token, method, url, payload);
      expect(response, `${method} ${url}`).toMatchObject({ status: 403, body: { error: 'token_scope' } });
    }
  });

  it('refuses unknown, malformed, expired and revoked tokens, whatever cookie comes along', async () => {
    const cookie = await stack.admin
      .inject({
        method: 'POST',
        url: '/api/login',
        headers: { 'x-pi-share': '1' },
        payload: { password: 'correct horse battery' },
      })
      .then((response) => String(response.headers['set-cookie']).split(';')[0] as string);
    const valid = await newToken('revoked');
    const short = await newToken('short-lived', Date.now() + 150);

    const bad = [`pis_${'A'.repeat(43)}`, 'pis_short', valid.token.slice(0, -1), ''];
    for (const token of bad) {
      const response = await withToken(token, 'GET', '/api/links', undefined, { cookie });
      expect(response.status, token).toBe(401);
    }
    for (const authorization of [`Basic ${valid.token}`, valid.token, `Bearer  ${valid.token}`]) {
      const response = await stack.admin.inject({
        method: 'GET',
        url: '/api/links',
        headers: { authorization, cookie },
      });
      expect(response.statusCode, authorization).toBe(401);
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await withToken(short.token, 'GET', '/api/links')).status).toBe(401);

    const kept = (await withToken(valid.token, 'POST', '/api/links', { paths: ['Work/notes.txt'] })).body as LinkDetail;
    expect((await stack.adminCall('DELETE', `/api/tokens/${valid.id}`)).status).toBe(204);
    expect((await withToken(valid.token, 'GET', '/api/links')).status).toBe(401);
    expect((await stack.adminCall('GET', `/api/links/${kept.id}`)).body).toMatchObject({ createdBy: 'revoked' });
    expect((await stack.adminCall('DELETE', `/api/tokens/${valid.id}`)).status).toBe(404);
  });

  it('is never read from the query string', async () => {
    const { token } = await newToken('query');
    for (const url of [`/api/links?token=${token}`, `/api/links?access_token=${token}`]) {
      expect((await stack.admin.inject({ method: 'GET', url })).statusCode).toBe(401);
    }
  });

  it('still answers only from the allowed networks', async () => {
    const { token } = await newToken('network');
    const response = await stack.admin.inject({
      method: 'GET',
      url: '/api/links',
      remoteAddress: '10.0.1.20',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(403);
  });

  it('validates names, expiry and how many tokens there are', async () => {
    const invalid = [
      { name: '', expiresAt: null },
      { name: 'x'.repeat(61), expiresAt: null },
      { name: 'past', expiresAt: Date.now() - 1000 },
      { name: 'missing expiry' },
    ];
    for (const body of invalid) expect((await stack.adminCall('POST', '/api/tokens', body)).status).toBe(400);

    const existing = ((await stack.adminCall('GET', '/api/tokens')).body as TokenView[]).length;
    for (let i = existing; i < 20; i++) await newToken(`filler ${i}`, null);
    const refused = await stack.adminCall('POST', '/api/tokens', { name: 'one too many', expiresAt: null });
    expect(refused).toMatchObject({ status: 409, body: { error: 'too_many_tokens' } });
  });
});

describe('links created from the admin', () => {
  it('take the defaults too when a field is left out', async () => {
    const before = Date.now();
    const link = (await stack.adminCall('POST', '/api/links', { paths: ['Work/notes.txt'] })).body as LinkDetail;
    expect(link.expiresAt).toBeGreaterThanOrEqual(before + 7 * DAY);
    expect(link.maxDownloads).toBeNull();
    const never = (await stack.adminCall('POST', '/api/links', { paths: ['Work/notes.txt'], expiresAt: null }))
      .body as LinkDetail;
    expect(never.expiresAt).toBeNull();
  });
});
