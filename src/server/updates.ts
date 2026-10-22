import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  finalUpdateStates,
  type ReleaseInfo,
  type UpdateInfo,
  type UpdateStatus,
  updateStates,
} from '../shared/api.ts';
import type { Settings } from './settings.ts';
import { ShareError } from './shares.ts';

export const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const CHECK_EVERY = 6 * 60 * 60 * 1000;
const MAX_STATUS_BYTES = 4096;
const MAX_NOTES = 8000;

export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

/** The version this process runs, from the package.json shipped next to the code. */
export function currentVersion(): string {
  const file = new URL('../../package.json', import.meta.url);
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { version: string }).version;
}

export type FetchLatest = () => Promise<ReleaseInfo | null>;

const releaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  body: z.string().nullable(),
  html_url: z.url(),
  published_at: z.string().nullable(),
});

/** The latest published, non-prerelease release of a GitHub repository. */
export function githubLatest(repo: string, userAgent: string): FetchLatest {
  return async () => {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': userAgent, 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    const release = releaseSchema.parse(await response.json());
    const version = release.tag_name.replace(/^v/, '');
    if (!VERSION.test(version) || release.draft || release.prerelease) return null;
    const url = release.html_url.startsWith(`https://github.com/${repo}/`)
      ? release.html_url
      : `https://github.com/${repo}/releases`;
    return { version, notes: (release.body ?? '').slice(0, MAX_NOTES), url, publishedAt: release.published_at };
  };
}

const statusSchema = z.object({
  state: z.enum(updateStates),
  version: z.string().regex(VERSION),
  message: z.string().max(500).nullable().default(null),
  at: z.number(),
});

export type UpdatesDeps = {
  current: string;
  fetchLatest: FetchLatest;
  settings: Settings;
  autoCheckDefault: boolean;
  /** Where the admin leaves an install request for the updater on the host (writable here). */
  requestDir: string;
  /** Where the updater reports progress (read-only here). */
  statusDir: string;
};

/**
 * Knows the running and the latest version and hands install requests to the updater on the host. The admin never
 * installs anything itself: it only writes which release it would like, and the updater re-checks everything.
 */
export class Updates {
  private readonly deps: UpdatesDeps;
  private latest: ReleaseInfo | null = null;
  private checkedAt: number | null = null;
  private error: string | null = null;
  private checking: Promise<void> | null = null;

  constructor(deps: UpdatesDeps) {
    this.deps = deps;
  }

  get autoCheck(): boolean {
    return this.deps.settings.updates(this.deps.autoCheckDefault).autoCheck;
  }

  setAutoCheck(autoCheck: boolean) {
    this.deps.settings.setUpdates({ autoCheck });
  }

  check(): Promise<void> {
    this.checking ??= this.deps
      .fetchLatest()
      .then((latest) => {
        this.latest = latest;
        this.error = null;
      })
      .catch((error: unknown) => {
        this.error = error instanceof Error ? error.message.slice(0, 200) : 'check failed';
      })
      .finally(() => {
        this.checkedAt = Date.now();
        this.checking = null;
      });
    return this.checking;
  }

  /** Checks in the background when automatic checks are on and the last one is old. */
  maybeCheck() {
    if (this.autoCheck && (this.checkedAt === null || Date.now() - this.checkedAt > CHECK_EVERY)) void this.check();
  }

  get installable(): boolean {
    const { requestDir, statusDir } = this.deps;
    return !!requestDir && !!statusDir && isDirectory(requestDir) && isDirectory(statusDir);
  }

  status(): UpdateStatus | null {
    if (!this.deps.statusDir) return null;
    try {
      const file = path.join(this.deps.statusDir, 'status.json');
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        if (fs.fstatSync(fd).size > MAX_STATUS_BYTES) return null;
        return statusSchema.parse(JSON.parse(fs.readFileSync(fd, 'utf8')));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  info(): UpdateInfo {
    const { current } = this.deps;
    return {
      current,
      latest: this.latest,
      available: !!this.latest && compareVersions(this.latest.version, current) > 0,
      checkedAt: this.checkedAt,
      error: this.error,
      autoCheck: this.autoCheck,
      installable: this.installable,
      status: this.status(),
    };
  }

  /** Asks the updater on the host for a release newer than the running one, known from the last check. */
  requestInstall(version: string) {
    if (!this.installable) throw new ShareError(501, 'not_installable');
    if (!this.latest || this.latest.version !== version || compareVersions(version, this.deps.current) <= 0) {
      throw new ShareError(409, 'not_available');
    }
    const status = this.status();
    if (status && !finalUpdateStates.includes(status.state)) throw new ShareError(409, 'in_progress');

    const request = JSON.stringify({ version, requestedAt: Date.now() });
    const temporary = path.join(this.deps.requestDir, `.request-${crypto.randomBytes(8).toString('hex')}`);
    fs.writeFileSync(temporary, request, { flag: 'wx', mode: 0o640 });
    fs.renameSync(temporary, path.join(this.deps.requestDir, 'request.json'));
  }
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
