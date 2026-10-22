import crypto from 'node:crypto';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type {
  CreateLinkBody,
  EventType,
  EventView,
  LinkCounts,
  LinkDetail,
  LinkFileView,
  LinkState,
  LinkSummary,
  UpdateLinkBody,
} from '../shared/api.ts';
import { createLinkBody, updateLinkBody } from '../shared/api.ts';
import { hashSecret, keyProof, passwordVerifier, randomId, safeEqual, sha256, type Vault } from './crypto.ts';
import { type Db, schema } from './db/index.ts';
import type { SensitiveList } from './sensitive.ts';
import { type Storage, StorageError, type StoredFile } from './storage.ts';

const { links, linkFiles, events } = schema;

type LinkRow = typeof links.$inferSelect;
type FileRow = typeof linkFiles.$inferSelect;

export class ShareError extends Error {
  readonly status: number;
  readonly code: string;
  readonly data?: Record<string, unknown>;

  constructor(status: number, code: string, data?: Record<string, unknown>) {
    super(code);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export type Visit = {
  ip?: string | null;
  country?: string | null;
  userAgent?: string | null;
  language?: string | null;
  visitor?: string | null;
};

export type NewEvent = Visit & {
  type: EventType;
  file?: number | null;
  downloadId?: string | null;
  bytes?: number | null;
  detail?: string | null;
};

export type ServableLink = { link: LinkRow; files: (FileRow & { state: LinkFileView['state'] })[]; key: Buffer };

const EMPTY_COUNTS: LinkCounts = { opens: 0, started: 0, downloads: 0, verified: 0, visitors: 0, failedPasswords: 0 };

export type SharesDeps = {
  db: Db;
  storage: Storage;
  vault: Vault;
  sensitive: SensitiveList;
  publicUrl: string;
  maxPasswordFailures: number;
};

export class Shares {
  private readonly db: Db;
  private readonly storage: Storage;
  private readonly vault: Vault;
  private readonly sensitive: SensitiveList;
  private readonly publicUrl: string;
  private readonly maxPasswordFailures: number;
  /** Bumped on every change to links, so cached views of them can tell they are stale. */
  revision = 0;

  constructor(deps: SharesDeps) {
    this.db = deps.db;
    this.storage = deps.storage;
    this.vault = deps.vault;
    this.sensitive = deps.sensitive;
    this.publicUrl = deps.publicUrl;
    this.maxPasswordFailures = deps.maxPasswordFailures;
  }

  async create(input: CreateLinkBody): Promise<LinkDetail> {
    const body = createLinkBody.parse(input);
    const files = this.resolveFiles(body.files);

    if (!body.confirmSensitive) {
      const flagged: string[] = [];
      for (const file of files) if (await this.sensitive.matches(file)) flagged.push(file.path);
      if (flagged.length) throw new ShareError(409, 'sensitive', { files: flagged });
    }

    const id = randomId(16);
    const key = crypto.randomBytes(32);
    const passwordHash = body.password ? await hashSecret(await passwordVerifier(body.password, key, id)) : null;

    this.db.transaction((tx) => {
      tx.insert(links)
        .values({
          id,
          label: body.label,
          sealedKey: this.vault.seal(key, id),
          passwordHash,
          createdAt: Date.now(),
          expiresAt: body.expiresAt,
          maxDownloads: body.maxDownloads,
        })
        .run();
      tx.insert(linkFiles)
        .values(
          files.map((file, position) => ({
            linkId: id,
            position,
            path: file.path,
            name: file.name,
            size: file.size,
            modifiedAt: file.modifiedAt,
          })),
        )
        .run();
    });
    this.revision++;
    return this.detail(id);
  }

  private resolveFiles(paths: string[]): StoredFile[] {
    const seen = new Set<string>();
    return paths.flatMap((relative) => {
      try {
        const file = this.storage.file(relative);
        if (seen.has(file.path)) return [];
        seen.add(file.path);
        return [file];
      } catch (error) {
        if (error instanceof StorageError) throw new ShareError(400, `file_${error.code}`, { path: relative });
        throw error;
      }
    });
  }

  list(): LinkSummary[] {
    const rows = this.db.select().from(links).orderBy(desc(links.createdAt)).all();
    const counts = this.counts();
    return rows.map((row) => this.summarize(row, this.filesOf(row.id), counts.get(row.id)));
  }

  detail(id: string): LinkDetail {
    const row = this.row(id);
    const summary = this.summarize(row, this.filesOf(id), this.counts(id).get(id));
    const history = this.db
      .select()
      .from(events)
      .where(eq(events.linkId, id))
      .orderBy(desc(events.at), desc(events.id))
      .limit(500)
      .all();
    return { ...summary, url: this.url(row), events: history.map(({ linkId: _, ...event }) => event as EventView) };
  }

  async update(id: string, input: UpdateLinkBody): Promise<LinkDetail> {
    const patch = updateLinkBody.parse(input);
    const row = this.row(id);
    const changes: Partial<LinkRow> = {};
    if (patch.label !== undefined) changes.label = patch.label;
    if (patch.expiresAt !== undefined) changes.expiresAt = patch.expiresAt;
    if (patch.maxDownloads !== undefined) changes.maxDownloads = patch.maxDownloads;
    if (patch.password !== undefined) {
      const key = this.vault.open(row.sealedKey, id);
      changes.passwordHash = patch.password ? await hashSecret(await passwordVerifier(patch.password, key, id)) : null;
    }
    if (patch.active !== undefined) {
      changes.active = patch.active;
      if (patch.active) Object.assign(changes, { lockedAt: null, failedPasswords: 0 });
    }

    this.db.transaction((tx) => {
      if (Object.keys(changes).length) tx.update(links).set(changes).where(eq(links.id, id)).run();
      if (patch.acceptChanges) {
        for (const file of this.filesOf(id)) {
          if (this.storage.state(file) !== 'changed') continue;
          const current = this.storage.file(file.path);
          tx.update(linkFiles)
            .set({ size: current.size, modifiedAt: current.modifiedAt })
            .where(and(eq(linkFiles.linkId, id), eq(linkFiles.position, file.position)))
            .run();
        }
      }
    });
    this.revision++;
    return this.detail(id);
  }

  remove(id: string) {
    this.row(id);
    this.db.delete(links).where(eq(links.id, id)).run();
    this.revision++;
  }

  activeCount(): number {
    return this.list().filter((link) => link.state === 'active').length;
  }

  find(id: string): LinkRow | undefined {
    return this.db.select().from(links).where(eq(links.id, id)).get();
  }

  /** True when the caller derived the proof from the link key, i.e. holds the whole link and not only its id. */
  holdsKey(link: LinkRow, proof: string | undefined): boolean {
    return !!proof && safeEqual(proof, keyProof(this.vault.open(link.sealedKey, link.id), link.id));
  }

  /** Changes whenever the password is set, changed or removed, so older tickets stop working. */
  passwordGeneration(link: LinkRow): string {
    return sha256(link.passwordHash ?? '').slice(0, 12);
  }

  /** What the broker may serve right now, or why not. */
  servable(id: string): { ok: true; value: ServableLink } | { ok: false; reason: LinkState | 'not_found' } {
    const link = this.db.select().from(links).where(eq(links.id, id)).get();
    if (!link) return { ok: false, reason: 'not_found' };
    const files = this.filesOf(id).map((file) => ({ ...file, state: this.storage.state(file) }));
    const state = this.stateOf(link, files, this.counts(id).get(id) ?? EMPTY_COUNTS);
    if (state !== 'active') return { ok: false, reason: state };
    return { ok: true, value: { link, files, key: this.vault.open(link.sealedKey, id) } };
  }

  record(linkId: string, event: NewEvent) {
    this.db
      .insert(events)
      .values({
        linkId,
        at: Date.now(),
        type: event.type,
        file: event.file ?? null,
        downloadId: event.downloadId ?? null,
        ip: event.ip ?? null,
        country: event.country ?? null,
        userAgent: event.userAgent?.slice(0, 512) ?? null,
        language: event.language?.slice(0, 128) ?? null,
        visitor: event.visitor ?? null,
        bytes: event.bytes ?? null,
        detail: event.detail?.slice(0, 256) ?? null,
      })
      .run();
  }

  private startedDownload(linkId: string, downloadId: string) {
    return this.db
      .select({ file: events.file })
      .from(events)
      .where(and(eq(events.linkId, linkId), eq(events.downloadId, downloadId), eq(events.type, 'download_started')))
      .get();
  }

  hasResult(linkId: string, downloadId: string): boolean {
    const row = this.db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.linkId, linkId),
          eq(events.downloadId, downloadId),
          sql`${events.type} in ('download_verified', 'download_failed')`,
        ),
      )
      .get();
    return row !== undefined;
  }

  pruneEvents(olderThanDays: number): number {
    const cutoff = Date.now() - olderThanDays * 86_400_000;
    return this.db.delete(events).where(lt(events.at, cutoff)).run().changes;
  }

  hasDownload(linkId: string, downloadId: string): boolean {
    return this.startedDownload(linkId, downloadId) !== undefined;
  }

  downloadFile(linkId: string, downloadId: string): number | null {
    return this.startedDownload(linkId, downloadId)?.file ?? null;
  }

  /** Counts a wrong password; returns true when the link just got locked. */
  failPassword(link: LinkRow, visit: Visit): boolean {
    this.record(link.id, { ...visit, type: 'password_failed' });
    const failures = link.failedPasswords + 1;
    const lock = failures >= this.maxPasswordFailures;
    this.db
      .update(links)
      .set({ failedPasswords: failures, ...(lock ? { lockedAt: Date.now() } : {}) })
      .where(eq(links.id, link.id))
      .run();
    if (lock) {
      this.record(link.id, { ...visit, type: 'locked', detail: `${failures} wrong passwords` });
      this.revision++;
    }
    return lock;
  }

  unlocked(link: LinkRow, visit: Visit) {
    this.record(link.id, { ...visit, type: 'unlocked' });
    if (link.failedPasswords > 0) this.db.update(links).set({ failedPasswords: 0 }).where(eq(links.id, link.id)).run();
  }

  private row(id: string): LinkRow {
    const row = this.db.select().from(links).where(eq(links.id, id)).get();
    if (!row) throw new ShareError(404, 'not_found');
    return row;
  }

  private filesOf(id: string): FileRow[] {
    return this.db.select().from(linkFiles).where(eq(linkFiles.linkId, id)).orderBy(linkFiles.position).all();
  }

  private url(row: LinkRow): string {
    return `${this.publicUrl}/d/${row.id}#${this.vault.open(row.sealedKey, row.id).toString('base64url')}`;
  }

  private counts(id?: string): Map<string, LinkCounts & { lastActivityAt: number | null }> {
    const rows = this.db
      .select({
        linkId: events.linkId,
        opens: sql<number>`sum(${events.type} = 'open')`,
        started: sql<number>`count(distinct case when ${events.type} = 'download_started' then ${events.downloadId} end)`,
        downloads: sql<number>`count(distinct case when ${events.type} = 'download_finished' then ${events.downloadId} end)`,
        verified: sql<number>`count(distinct case when ${events.type} = 'download_verified' then ${events.downloadId} end)`,
        visitors: sql<number>`count(distinct case when ${events.type} = 'open' then coalesce(${events.visitor}, ${events.ip}) end)`,
        failedPasswords: sql<number>`sum(${events.type} = 'password_failed')`,
        lastActivityAt: sql<number | null>`max(case when ${events.type} != 'preview' then ${events.at} end)`,
      })
      .from(events)
      .where(id ? eq(events.linkId, id) : undefined)
      .groupBy(events.linkId)
      .all();
    return new Map(rows.map(({ linkId, ...counts }) => [linkId, counts]));
  }

  private stateOf(link: LinkRow, files: { state: LinkFileView['state'] }[], counts: LinkCounts): LinkState {
    if (link.lockedAt) return 'locked';
    if (!link.active) return 'disabled';
    if (link.expiresAt && link.expiresAt <= Date.now()) return 'expired';
    // Every started download uses up the quota: counting only finished ones lets a client stop one record short.
    if (link.maxDownloads && counts.started >= link.maxDownloads) return 'exhausted';
    if (!files.some((file) => file.state === 'ok')) return 'unavailable';
    return 'active';
  }

  private summarize(
    row: LinkRow,
    files: FileRow[],
    counts: (LinkCounts & { lastActivityAt: number | null }) | undefined,
  ): LinkSummary {
    const views = files.map((file) => ({
      position: file.position,
      path: file.path,
      name: file.name,
      size: file.size,
      state: this.storage.state(file),
    }));
    const { lastActivityAt, ...linkCounts } = counts ?? { ...EMPTY_COUNTS, lastActivityAt: null };
    return {
      id: row.id,
      label: row.label,
      state: this.stateOf(row, views, linkCounts),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      maxDownloads: row.maxDownloads,
      hasPassword: row.passwordHash !== null,
      files: views,
      counts: linkCounts,
      lastActivityAt,
    };
  }
}
