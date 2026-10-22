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
    version = ref.rsplit(":", 1)[1]
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
    if "ps" in args:
        running = open(env_file).read()
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
function runUpdater(extraEnv: Record<string, string> = {}, pathOverride?: string) {
  return new Promise<{ status: number; stderr: string }>((resolve) => {
    execFile(
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
}

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
    for (const body of [{ version: '0.3.0' }, { version: '0.2.9' }, { version: '1.0.0; rm -rf /' }, '{nope', '[]']) {
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
    // A PATH with python3 and nothing else, so gh is surely missing.
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.symlinkSync(PYTHON, path.join(bin, 'python3'));
    await runUpdater({}, bin);
    expect(status()).toMatchObject({
      state: 'failed',
      message: 'build provenance is required but the GitHub CLI is not installed',
    });
    expect(env()).toContain(':0.3.0\n');
  });
});
