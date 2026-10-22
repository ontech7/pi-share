import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from './helpers.ts';

const UPDATER = path.resolve('contrib/updater/pi-share-updater.py');
const PYTHON = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim();
const IMAGE = 'ghcr.io/ontech7/pi-share';
const DIGEST = 'a'.repeat(64);

/** Stands in for the docker CLI: logs every call and answers like Docker would for the scenario in state.json. */
const DOCKER_STUB = `#!/usr/bin/env python3
import json, os, sys
state_dir = os.environ["STUB_STATE"]
state = json.load(open(os.path.join(state_dir, "state.json")))
args = sys.argv[1:]
with open(os.path.join(state_dir, "calls.log"), "a") as log:
    log.write(json.dumps(args) + "\\n")
if args[0] == "pull":
    sys.exit(1 if state.get("pullFails") else 0)
if args[:2] == ["image", "inspect"]:
    ref = args[-1]
    version = ref.split("@")[0].rsplit(":", 1)[1]
    version = state.get("versions", {}).get(version, version)
    if "Labels" in args[3]:
        labels = state.get("labels") or {
            "org.opencontainers.image.source": "https://github.com/ontech7/pi-share",
            "org.opencontainers.image.version": version,
        }
        print(json.dumps(labels))
    else:
        print(json.dumps(["${IMAGE}@sha256:${DIGEST}"]))
    sys.exit(0)
if args[0] == "compose":
    env_file = args[args.index("--env-file") + 1]
    running = open(env_file).read()
    if "up" in args:
        if any(f":{v}" in running for v in state.get("hang", [])):
            import time
            time.sleep(60)
        if state.get("lockData") and any(f":{v}" in running for v in state.get("unhealthy", [])):
            os.chmod(state["lockData"], 0o555)
    if "ps" in args:
        bad = any(f":{v}" in running for v in state.get("unhealthy", []))
        for name in ("pi-share-admin", "pi-share-edge"):
            print(json.dumps({"Name": name, "State": "running", "Health": "unhealthy" if bad else "healthy"}))
    sys.exit(0)
sys.exit(2)
`;

let server: http.Server;
let api = '';
const releases = new Map<string, { draft?: boolean; prerelease?: boolean }>();

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const tag = /^\/repos\/ontech7\/pi-share\/releases\/tags\/v([\d.]+)$/.exec(request.url ?? '')?.[1];
    const release = tag ? releases.get(tag) : undefined;
    if (!tag || !release) return response.writeHead(404).end('{}');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ tag_name: `v${tag}`, draft: false, prerelease: false, ...release }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let root: string;
let dirs: Record<'request' | 'status' | 'backup' | 'data' | 'etc' | 'stub', string>;

beforeEach(() => {
  releases.clear();
  releases.set('0.4.0', {});
  root = tempDir('pi-share-updater-');
  dirs = {
    request: path.join(root, 'request'),
    status: path.join(root, 'status'),
    backup: path.join(root, 'backup'),
    data: path.join(root, 'data'),
    etc: path.join(root, 'etc'),
    stub: path.join(root, 'stub'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dirs.data, 'share.db'), 'database at 0.3.0');
  fs.writeFileSync(path.join(dirs.etc, '.env'), `TZ=UTC\nPI_SHARE_IMAGE=${IMAGE}:0.3.0\n`);
  fs.writeFileSync(path.join(dirs.etc, 'compose.yaml'), 'services: {}\n');
  fs.writeFileSync(path.join(dirs.stub, 'docker'), DOCKER_STUB, { mode: 0o755 });
  writeConfig({});
  setState({});
});

function writeConfig(extra: Record<string, string>) {
  const values = {
    REPO: 'ontech7/pi-share',
    IMAGE,
    COMPOSE_FILE: path.join(dirs.etc, 'compose.yaml'),
    ENV_FILE: path.join(dirs.etc, '.env'),
    DATA_DIR: dirs.data,
    REQUEST_DIR: dirs.request,
    STATUS_DIR: dirs.status,
    BACKUP_DIR: dirs.backup,
    HEALTH_TIMEOUT: '1',
    COOLDOWN: '0',
    VERIFY_PROVENANCE: 'off',
    DOCKER: path.join(dirs.stub, 'docker'),
    GITHUB_API: api,
    ...extra,
  };
  const text = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  fs.writeFileSync(path.join(dirs.etc, 'updater.env'), text, { mode: 0o644 });
  fs.chmodSync(path.join(dirs.etc, 'updater.env'), 0o644);
}

function setState(state: Record<string, unknown>) {
  fs.writeFileSync(path.join(dirs.stub, 'state.json'), JSON.stringify(state));
}

function request(body: unknown) {
  fs.writeFileSync(path.join(dirs.request, 'request.json'), typeof body === 'string' ? body : JSON.stringify(body));
}

/** Async on purpose: the fake GitHub API lives in this process and must keep answering while Python runs. */
function startUpdater(extraEnv: Record<string, string> = {}, pathOverride?: string) {
  let child: ReturnType<typeof execFile> | undefined;
  const done = new Promise<{ status: number; stderr: string }>((resolve) => {
    child = execFile(
      PYTHON,
      ['-I', UPDATER],
      {
        env: {
          ...(pathOverride ? { PATH: pathOverride } : process.env),
          PI_SHARE_UPDATER_CONFIG: path.join(dirs.etc, 'updater.env'),
          STUB_STATE: dirs.stub,
          ...extraEnv,
        },
        timeout: 60_000,
      },
      (error, _stdout, stderr) => resolve({ status: error ? Number(error.code ?? 1) : 0, stderr }),
    );
  });
  return { done, child: child as NonNullable<typeof child> };
}

const runUpdater = (extraEnv: Record<string, string> = {}, pathOverride?: string) =>
  startUpdater(extraEnv, pathOverride).done;

/** A PATH with python3 (and the given extra commands) and nothing else. */
function onlyPath(extra: Record<string, string> = {}) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(PYTHON, path.join(bin, 'python3'));
  for (const [name, script] of Object.entries(extra)) fs.writeFileSync(path.join(bin, name), script, { mode: 0o755 });
  return bin;
}

const until = async (condition: () => boolean) => {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
};

const status = () => JSON.parse(fs.readFileSync(path.join(dirs.status, 'status.json'), 'utf8'));
const env = () => fs.readFileSync(path.join(dirs.etc, '.env'), 'utf8');
const calls = (): string[][] => {
  const log = path.join(dirs.stub, 'calls.log');
  return fs.existsSync(log)
    ? fs
        .readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
};

describe('the updater on the host', () => {
  it('does nothing without a request', async () => {
    expect((await runUpdater()).status).toBe(0);
    expect(fs.existsSync(path.join(dirs.status, 'status.json'))).toBe(false);
    expect(calls()).toEqual([]);
  });

  it('installs a newer release, pinned by digest, after backing up the database', async () => {
    request({ version: '0.4.0' });
    expect((await runUpdater()).status).toBe(0);
    expect(status()).toMatchObject({ state: 'done', version: '0.4.0', message: null });
    expect(env()).toBe(`TZ=UTC\nPI_SHARE_IMAGE=${IMAGE}:0.4.0@sha256:${DIGEST}\n`);
    expect(fs.existsSync(path.join(dirs.request, 'request.json'))).toBe(false);
    const [backup] = fs.readdirSync(dirs.backup).filter((name) => !name.startsWith('.'));
    expect(fs.readFileSync(path.join(dirs.backup, backup as string, 'share.db'), 'utf8')).toBe('database at 0.3.0');
    expect(calls().map((args) => args.find((arg) => ['pull', 'stop', 'up', 'ps'].includes(arg)) ?? args[0])).toEqual(
      expect.arrayContaining(['pull', 'stop', 'up', 'ps']),
    );
  });

  it('restarts with every compose file listed, as Docker does with COMPOSE_FILE', async () => {
    const override = path.join(dirs.etc, 'compose.updater.yaml');
    fs.writeFileSync(override, 'services: {}\n');
    writeConfig({ COMPOSE_FILE: `${path.join(dirs.etc, 'compose.yaml')}:${override}` });
    request({ version: '0.4.0' });
    await runUpdater();
    expect(status().state).toBe('done');
    const up = calls().find((args) => args.includes('up')) ?? [];
    expect(up.filter((arg) => arg === '-f')).toHaveLength(2);
    expect(up).toContain(override);
  });

  it('refuses the running version, older ones and anything that is not a version', async () => {
    const bodies = [
      { version: '0.3.0' },
      { version: '0.2.9' },
      { version: '1.0.0; rm -rf /' },
      { version: '0.4.0\n' },
      { version: '٠.4.0' },
      { version: '０.4.0' },
      '{nope',
      '[]',
      `${'['.repeat(5000)}${']'.repeat(5000)}`,
    ];
    for (const body of bodies) {
      request(body);
      await runUpdater();
      expect(status().state).toBe('failed');
      expect(env()).toContain(':0.3.0\n');
    }
    expect(calls()).toEqual([]);
  });

  it('does not follow a request that is a symlink, and never echoes what it pointed to', async () => {
    const secret = path.join(root, 'secret.txt');
    fs.writeFileSync(secret, '{"version": "9.9.9", "token": "do-not-leak"}');
    fs.symlinkSync(secret, path.join(dirs.request, 'request.json'));
    await runUpdater();
    expect(status()).toMatchObject({ state: 'failed', message: 'the request was not a plain file' });
    expect(fs.readFileSync(path.join(dirs.status, 'status.json'), 'utf8')).not.toContain('do-not-leak');
    expect(fs.existsSync(path.join(dirs.request, 'request.json'))).toBe(false);
    expect(fs.existsSync(secret)).toBe(true);
  });

  it('refuses versions that are not published releases', async () => {
    releases.set('0.5.0', { prerelease: true });
    for (const version of ['0.9.0', '0.5.0']) {
      request({ version });
      await runUpdater();
      expect(status()).toMatchObject({ state: 'failed', message: 'this version is not a published release' });
    }
    expect(calls()).toEqual([]);
  });

  it('refuses an image that does not say it comes from this repository', async () => {
    setState({
      labels: {
        'org.opencontainers.image.source': 'https://github.com/someone/else',
        'org.opencontainers.image.version': '0.4.0',
      },
    });
    request({ version: '0.4.0' });
    await runUpdater();
    expect(status()).toMatchObject({
      state: 'failed',
      message: 'the image does not come from the expected repository',
    });
    expect(calls().some((args) => args.includes('stop'))).toBe(false);
    expect(env()).toContain(':0.3.0\n');
  });

  it('brings back the previous image and database when the new version does not become healthy', async () => {
    setState({ unhealthy: ['0.4.0'] });
    request({ version: '0.4.0' });
    fs.writeFileSync(path.join(dirs.data, 'share.db-wal'), 'old wal');
    await runUpdater();
    expect(status()).toMatchObject({
      state: 'rolled_back',
      version: '0.4.0',
      message: '0.4.0 did not start correctly; 0.3.0 is running again',
    });
    expect(env()).toBe(`TZ=UTC\nPI_SHARE_IMAGE=${IMAGE}:0.3.0\n`);
    expect(fs.readFileSync(path.join(dirs.data, 'share.db'), 'utf8')).toBe('database at 0.3.0');
    expect(fs.readFileSync(path.join(dirs.data, 'share.db-wal'), 'utf8')).toBe('old wal');
  });

  it('refuses to run with a configuration others may write', async () => {
    fs.chmodSync(path.join(dirs.etc, 'updater.env'), 0o666);
    const result = await runUpdater();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('not writable by group or others');
  });

  it('requires a verified build provenance when told to, and refuses without the GitHub CLI', async () => {
    writeConfig({ VERIFY_PROVENANCE: 'required' });
    request({ version: '0.4.0' });
    await runUpdater({}, onlyPath());
    expect(status()).toMatchObject({
      state: 'failed',
      message: 'build provenance is required but the GitHub CLI or its token is missing',
    });
    expect(env()).toContain(':0.3.0\n');
  });

  it('verifies the provenance of the exact digest it installs, built by the release workflow from its tag', async () => {
    const gh = `#!/bin/sh\nprintf '%s\\n' "$@" > "$STUB_STATE/gh.args"\nexit "\${GH_EXIT:-0}"\n`;
    const bin = onlyPath({ gh });
    writeConfig({ VERIFY_PROVENANCE: 'auto' });
    request({ version: '0.4.0' });
    await runUpdater({ GH_TOKEN: 'token' }, bin);
    expect(status().state).toBe('done');
    expect(fs.readFileSync(path.join(dirs.stub, 'gh.args'), 'utf8').trim().split('\n')).toEqual([
      'attestation',
      'verify',
      `oci://${IMAGE}@sha256:${DIGEST}`,
      '--repo',
      'ontech7/pi-share',
      '--signer-workflow',
      'ontech7/pi-share/.github/workflows/release.yml',
      '--source-ref',
      'refs/tags/v0.4.0',
      '--deny-self-hosted-runners',
    ]);

    fs.writeFileSync(path.join(dirs.etc, '.env'), `PI_SHARE_IMAGE=${IMAGE}:0.3.0\n`);
    request({ version: '0.4.0' });
    await runUpdater({ GH_TOKEN: 'token', GH_EXIT: '1' }, bin);
    expect(status()).toMatchObject({
      state: 'failed',
      message: 'the build provenance of the image could not be verified',
    });
    expect(env()).toContain(':0.3.0\n');
  });

  it('skips the provenance check by default when the GitHub CLI has no token', async () => {
    writeConfig({ VERIFY_PROVENANCE: 'auto' });
    const bin = onlyPath({ gh: '#!/bin/sh\nexit 1\n' });
    request({ version: '0.4.0' });
    await runUpdater({}, bin);
    expect(status().state).toBe('done');
  });

  it('reads the running version from the image when the env file names a moving x.y tag', async () => {
    fs.writeFileSync(path.join(dirs.etc, '.env'), `PI_SHARE_IMAGE=${IMAGE}:0.3\n`);
    setState({ versions: { '0.3': '0.3.4' } });
    request({ version: '0.3.2' });
    await runUpdater();
    expect(status()).toMatchObject({ state: 'failed', message: '0.3.2 is not newer than the running 0.3.4' });
    request({ version: '0.4.0' });
    await runUpdater();
    expect(status().state).toBe('done');
    expect(env()).toBe(`PI_SHARE_IMAGE=${IMAGE}:0.4.0@sha256:${DIGEST}\n`);
  });

  it('accepts a version label written as the tag name', async () => {
    setState({
      labels: {
        'org.opencontainers.image.source': 'https://github.com/ontech7/pi-share',
        'org.opencontainers.image.version': 'v0.4.0',
      },
    });
    request({ version: '0.4.0' });
    await runUpdater();
    expect(status().state).toBe('done');
  });

  it('keeps the mode of the env file it rewrites', async () => {
    fs.chmodSync(path.join(dirs.etc, '.env'), 0o600);
    request({ version: '0.4.0' });
    await runUpdater();
    expect(status().state).toBe('done');
    expect(fs.statSync(path.join(dirs.etc, '.env')).mode & 0o777).toBe(0o600);
  });

  it('removes a request that is a directory instead of tripping over it', async () => {
    fs.mkdirSync(path.join(dirs.request, 'request.json', 'deeper'), { recursive: true });
    expect((await runUpdater()).status).toBe(0);
    expect(status()).toMatchObject({ state: 'failed', message: 'the request was not a small plain file' });
    expect(fs.existsSync(path.join(dirs.request, 'request.json'))).toBe(false);
  });

  it('spaces runs out, so a flood of requests cannot keep it busy', async () => {
    writeConfig({ COOLDOWN: '2' });
    request('{nope');
    await runUpdater();
    request('{nope');
    const started = Date.now();
    await runUpdater();
    expect(Date.now() - started).toBeGreaterThan(1500);
  });

  it('refuses to back up a database larger than the free space, and starts the running version again', async () => {
    fs.truncateSync(path.join(dirs.data, 'share.db'), 15 * 1024 ** 4);
    request({ version: '0.4.0' });
    await runUpdater();
    expect(status()).toMatchObject({
      state: 'failed',
      message: 'there is not enough free space to back up the database, nothing was changed',
    });
    expect(fs.readdirSync(dirs.backup).filter((name) => !name.startsWith('.'))).toEqual([]);
    expect(calls().some((args) => args.includes('up'))).toBe(true);
    expect(env()).toContain(':0.3.0\n');
  });

  it('refuses to go on without a database to back up', async () => {
    fs.rmSync(path.join(dirs.data, 'share.db'));
    fs.mkdirSync(path.join(dirs.data, 'share.db'));
    request({ version: '0.4.0' });
    await runUpdater();
    expect(status()).toMatchObject({ state: 'failed', message: 'the database was not found, nothing was changed' });
    expect(env()).toContain(':0.3.0\n');
  });

  it('rolls back over whatever the new version left in place of the database files', async () => {
    setState({ unhealthy: ['0.4.0'] });
    request({ version: '0.4.0' });
    fs.mkdirSync(path.join(dirs.data, 'share.db-wal', 'deeper'), { recursive: true });
    await runUpdater();
    expect(status().state).toBe('rolled_back');
    expect(fs.existsSync(path.join(dirs.data, 'share.db-wal'))).toBe(false);
    expect(fs.readFileSync(path.join(dirs.data, 'share.db'), 'utf8')).toBe('database at 0.3.0');
  });

  it('still brings the previous version back when its database cannot be put back', async () => {
    setState({ unhealthy: ['0.4.0'], lockData: dirs.data });
    request({ version: '0.4.0' });
    try {
      await runUpdater();
    } finally {
      fs.chmodSync(dirs.data, 0o755);
    }
    expect(status()).toMatchObject({
      state: 'rolled_back',
      message: '0.4.0 did not start correctly; 0.3.0 is running again, but its database backup could not be put back',
    });
    expect(env()).toBe(`TZ=UTC\nPI_SHARE_IMAGE=${IMAGE}:0.3.0\n`);
    expect(calls().filter((args) => args.includes('up'))).toHaveLength(2);
  });

  it('rolls back when it is stopped half-way through the switch', async () => {
    setState({ hang: ['0.4.0'] });
    request({ version: '0.4.0' });
    const { done, child } = startUpdater();
    await until(() => calls().some((args) => args.includes('up')));
    child.kill('SIGTERM');
    await done;
    expect(status()).toMatchObject({
      state: 'rolled_back',
      message: 'the switch to 0.4.0 was interrupted; 0.3.0 is running again',
    });
    expect(env()).toBe(`TZ=UTC\nPI_SHARE_IMAGE=${IMAGE}:0.3.0\n`);
    expect(fs.existsSync(path.join(dirs.backup, '.switching'))).toBe(false);
  });

  it('undoes a switch a previous run could not finish, without a new request', async () => {
    const folder = path.join(dirs.backup, '20261022-000000-0.3.0');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'share.db'), 'database at 0.3.0');
    const before = env();
    fs.writeFileSync(path.join(dirs.etc, '.env'), `TZ=UTC\nPI_SHARE_IMAGE=${IMAGE}:0.4.0@sha256:${DIGEST}\n`);
    fs.writeFileSync(path.join(dirs.data, 'share.db'), 'database at 0.4.0');
    fs.writeFileSync(
      path.join(dirs.backup, '.switching'),
      JSON.stringify({ version: '0.4.0', current: '0.3.0', env: before, folder }),
    );
    await runUpdater();
    expect(status()).toMatchObject({
      state: 'rolled_back',
      version: '0.4.0',
      message: 'the update to 0.4.0 was interrupted; 0.3.0 is running again',
    });
    expect(env()).toBe(before);
    expect(fs.readFileSync(path.join(dirs.data, 'share.db'), 'utf8')).toBe('database at 0.3.0');
    expect(fs.existsSync(path.join(dirs.backup, '.switching'))).toBe(false);
  });
});
