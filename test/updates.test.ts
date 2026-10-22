import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { compareVersions, githubLatest } from '../src/server/updates.ts';
import type { UpdateInfo } from '../src/shared/api.ts';
import { tempDir } from './helpers.ts';
import { startStack } from './stack.ts';

const updateDir = tempDir('pi-share-update-');
const requestDir = path.join(updateDir, 'request');
const statusDir = path.join(updateDir, 'status');
fs.mkdirSync(requestDir);
fs.mkdirSync(statusDir);

let stack: Awaited<ReturnType<typeof startStack>>;

beforeAll(async () => {
  stack = await startStack(
    { 'a.txt': 'a' },
    { UPDATE_REQUEST_DIR: requestDir, UPDATE_STATUS_DIR: statusDir, UPDATE_CHECK: 'false' },
  );
});

afterAll(() => stack.close());

const info = async () => (await stack.adminCall('GET', '/api/updates')).body as UpdateInfo;
const release = (version: string) => ({
  version,
  notes: '### Added\n- Something',
  url: `https://github.com/ontech7/pi-share/releases/tag/v${version}`,
  publishedAt: '2026-10-22T20:00:00Z',
});
const writeStatus = (content: string) => fs.writeFileSync(path.join(statusDir, 'status.json'), content);

describe('update checks in the admin', () => {
  it('reports the running version and that the host can install', async () => {
    expect(await info()).toMatchObject({
      current: '1.2.3',
      latest: null,
      available: false,
      autoCheck: false,
      installable: true,
      status: null,
    });
  });

  it('finds a newer release when asked to check', async () => {
    stack.setRelease(release('1.3.0'));
    const checked = (await stack.adminCall('POST', '/api/updates/check')).body as UpdateInfo;
    expect(checked).toMatchObject({ available: true, latest: { version: '1.3.0' }, error: null });
    expect(checked.checkedAt).toBeTypeOf('number');
  });

  it('remembers whether to check by itself', async () => {
    expect((await stack.adminCall('PATCH', '/api/updates', { autoCheck: true })).body).toMatchObject({
      autoCheck: true,
    });
    expect((await info()).autoCheck).toBe(true);
    await stack.adminCall('PATCH', '/api/updates', { autoCheck: false });
  });
});

describe('install requests', () => {
  afterEach(() => {
    fs.rmSync(path.join(requestDir, 'request.json'), { force: true });
    fs.rmSync(path.join(statusDir, 'status.json'), { force: true });
  });

  it('refuses versions that are not the newer release found', async () => {
    for (const version of ['1.4.0', '1.2.3', '1.0.0']) {
      expect((await stack.adminCall('POST', '/api/updates/install', { version })).status, version).toBe(409);
    }
    expect((await stack.adminCall('POST', '/api/updates/install', { version: '1.3.0; reboot' })).status).toBe(400);
    expect(fs.existsSync(path.join(requestDir, 'request.json'))).toBe(false);
  });

  it('leaves a request with nothing but the version for the host', async () => {
    const response = await stack.adminCall('POST', '/api/updates/install', { version: '1.3.0' });
    expect(response.status).toBe(202);
    const request = JSON.parse(fs.readFileSync(path.join(requestDir, 'request.json'), 'utf8'));
    expect(Object.keys(request).sort()).toEqual(['requestedAt', 'version']);
    expect(request.version).toBe('1.3.0');
    expect(fs.readdirSync(requestDir)).toEqual(['request.json']);
  });

  it('shows the progress the host reports and refuses a second request meanwhile', async () => {
    writeStatus(JSON.stringify({ state: 'downloading', version: '1.3.0', message: null, at: 1 }));
    expect((await info()).status).toEqual({ state: 'downloading', version: '1.3.0', message: null, at: 1 });
    const busy = await stack.adminCall('POST', '/api/updates/install', { version: '1.3.0' });
    expect(busy).toMatchObject({ status: 409, body: { error: 'in_progress' } });
  });

  it('ignores a status file that is malformed, oversized or a symlink', async () => {
    for (const content of ['{nope', JSON.stringify({ state: 'hacked', version: '1.3.0', at: 1 }), 'x'.repeat(5000)]) {
      writeStatus(content);
      expect((await info()).status).toBeNull();
    }
    fs.rmSync(path.join(statusDir, 'status.json'));
    const elsewhere = path.join(updateDir, 'elsewhere.json');
    fs.writeFileSync(elsewhere, JSON.stringify({ state: 'done', version: '1.3.0', message: null, at: 1 }));
    fs.symlinkSync(elsewhere, path.join(statusDir, 'status.json'));
    expect((await info()).status).toBeNull();
  });
});

describe('versions and releases', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('compares versions numerically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3', '1.3.0')).toBe(-1);
  });

  const answer = (status: number, body: unknown) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    );
  const github = (overrides: Record<string, unknown> = {}) => ({
    tag_name: 'v0.4.0',
    draft: false,
    prerelease: false,
    body: 'notes',
    html_url: 'https://github.com/ontech7/pi-share/releases/tag/v0.4.0',
    published_at: '2026-10-22T20:00:00Z',
    ...overrides,
  });
  const latest = githubLatest('ontech7/pi-share', 'pi-share/test');

  it('reads the latest published release', async () => {
    answer(200, github());
    expect(await latest()).toEqual({
      version: '0.4.0',
      notes: 'notes',
      url: 'https://github.com/ontech7/pi-share/releases/tag/v0.4.0',
      publishedAt: '2026-10-22T20:00:00Z',
    });
  });

  it('ignores drafts, prereleases and odd tags, and never links outside the repository', async () => {
    for (const overrides of [{ draft: true }, { prerelease: true }, { tag_name: 'nightly' }]) {
      answer(200, github(overrides));
      expect(await latest()).toBeNull();
    }
    answer(200, github({ html_url: 'https://evil.example.com/' }));
    expect((await latest())?.url).toBe('https://github.com/ontech7/pi-share/releases');
  });

  it('treats a missing release as none and other answers as errors', async () => {
    answer(404, {});
    expect(await latest()).toBeNull();
    answer(500, {});
    await expect(latest()).rejects.toThrow('GitHub answered 500');
  });
});
