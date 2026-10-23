import crypto from 'node:crypto';
import { and, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import type {
  CreateLinkBody,
  EventType,
  EventView,
  LinkCounts,
  LinkDetail,
  LinkState,
  LinkSummary,
  Preferences,
  Provider,
  RefusalReason,
  UpdateLinkBody,
} from '../shared/api.ts';
import { createLinkBody, updateLinkBody } from '../shared/api.ts';
import { type ContentDeps, folderSnapshot, type Inspection, type Item, inspect, type Snapshot } from './content.ts';
import { hashSecret, keyProof, passwordVerifier, randomId, safeEqual, sha256, type Vault } from './crypto.ts';
import { type Db, schema } from './db/index.ts';
import { allowList, isAllowed } from './network.ts';
import type { SensitiveList } from './sensitive.ts';
import { type FolderFile, MAX_LINK_FILES, type Storage, StorageError } from './storage.ts';
import type { TokenOwner } from './tokens.ts';

const { links, linkFiles, folderSnapshots, events } = schema;

type LinkRow = typeof links.$inferSelect;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type NewItem = Omit<Item, 'position'> & { files: FolderFile[] | null };

const SNAPSHOT_CHUNK = 1_000;
const MAX_CHANGES = 1_000;

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
  path?: string | null;
  downloadId?: string | null;
  bytes?: number | null;
  detail?: string | null;
  counted?: boolean;
};

/** What a new link gets for the settings its request leaves out. */
export type LinkDefaults = Pick<Preferences, 'onChange' | 'expiryDays' | 'maxDownloads'>;

export type ServableLink = { link: LinkRow; content: Inspection; counts: LinkCounts; key: Buffer };

const EMPTY_COUNTS: LinkCounts = {
  opens: 0,
  started: 0,
  downloads: 0,
  recipients: 0,
  verified: 0,
  visitors: 0,
  failedPasswords: 0,
};

export type SharesDeps = {
  db: Db;
  storage: Storage;
  vault: Vault;
  sensitive: SensitiveList;
  publicUrl: string;
  maxPasswordFailures: number;
  providerOf?: (ip: string | null) => Provider | null;
  /** Told about every event after it is saved; the label is read only if the listener needs it. */
  onEvent?: (linkId: string, event: NewEvent, labelOf: () => string | null) => void;
};

export class Shares {
  private readonly db: Db;
  private readonly storage: Storage;
  private readonly vault: Vault;
  private readonly sensitive: SensitiveList;
  private readonly publicUrl: string;
  private readonly maxPasswordFailures: number;
  private readonly providerOf: (ip: string | null) => Provider | null;
  private readonly onEvent: SharesDeps['onEvent'];
  private readonly content: ContentDeps;
  /** Bumped on every change to links, so cached views of them can tell they are stale. */
  revision = 0;

  constructor(deps: SharesDeps) {
    this.db = deps.db;
    this.storage = deps.storage;
    this.vault = deps.vault;
    this.sensitive = deps.sensitive;
    this.publicUrl = deps.publicUrl;
    this.maxPasswordFailures = deps.maxPasswordFailures;
    this.providerOf = deps.providerOf ?? (() => null);
    this.onEvent = deps.onEvent;
    this.content = { storage: deps.storage, sensitive: deps.sensitive };
  }

  async create(input: CreateLinkBody, defaults: LinkDefaults, owner?: TokenOwner): Promise<LinkDetail> {
    const body = createLinkBody.parse(input);
    // Only a person in the admin may confirm a file on the sensitive list, never a program holding a token.
    const confirmed = body.confirmSensitive && !owner;
    const { items, flagged } = this.resolveItems(body.paths, confirmed);
    if (flagged.length && !confirmed) throw new ShareError(409, 'sensitive', { files: flagged });

    const id = randomId(16);
    const key = crypto.randomBytes(32);
    const passwordHash = body.password ? await hashSecret(await passwordVerifier(body.password, key, id)) : null;
    const now = Date.now();
    const defaultExpiry = defaults.expiryDays ? now + defaults.expiryDays * 86_400_000 : null;

    this.db.transaction((tx) => {
      tx.insert(links)
        .values({
          id,
          label: body.label,
          sealedKey: this.vault.seal(key, id),
          passwordHash,
          createdAt: now,
          expiresAt: body.expiresAt === undefined ? defaultExpiry : body.expiresAt,
          maxDownloads: body.maxDownloads === undefined ? defaults.maxDownloads : body.maxDownloads,
          onChange: body.onChange ?? defaults.onChange,
          allowedNetworks: body.allowedNetworks.length ? body.allowedNetworks : null,
          tokenId: owner?.id ?? null,
          createdBy: owner?.name ?? null,
        })
        .run();
      tx.insert(linkFiles)
        .values(items.map(({ files: _, ...item }, position) => ({ ...item, linkId: id, position })))
        .run();
      items.forEach((item, position) => {
        if (item.files) this.writeSnapshot(tx, id, position, item.files);
      });
    });
    this.revision++;
    return this.detail(id);
  }

  private resolveItems(paths: string[], includeSensitive: boolean): { items: NewItem[]; flagged: string[] } {
    const seen = new Set<string>();
    const items: NewItem[] = [];
    const flagged: string[] = [];
    for (const relative of paths) {
      try {
        if (this.storage.kindOf(relative) === 'file') {
          const file = this.storage.file(relative);
          if (seen.has(file.path)) continue;
          seen.add(file.path);
          if (this.sensitive.matches(file, file.absolute)) flagged.push(file.path);
          items.push({
            kind: 'file',
            path: file.path,
            name: file.name,
            size: file.size,
            modifiedAt: file.modifiedAt,
            files: null,
          });
        } else {
          const folder = this.storage.normalize(relative);
          if (seen.has(folder)) continue;
          seen.add(folder);
          const snapshot = folderSnapshot(this.content, folder, includeSensitive);
          flagged.push(...snapshot.flagged);
          items.push({
            kind: 'folder',
            path: folder,
            name: folder.split('/').at(-1) as string,
            size: snapshot.files.reduce((sum, file) => sum + file.size, 0),
            modifiedAt: 0,
            files: snapshot.files,
          });
        }
      } catch (error) {
        if (error instanceof StorageError) throw new ShareError(400, `file_${error.code}`, { path: relative });
        throw error;
      }
    }
    // Something picked inside a folder that is shared as a whole would appear twice.
    const folders = items.filter((item) => item.kind === 'folder').map((item) => `${item.path}/`);
    const outer = items.filter((item) => !folders.some((folder) => item.path.startsWith(folder)));
    const total = outer.reduce((sum, item) => sum + (item.files?.length ?? 1), 0);
    if (total > MAX_LINK_FILES) throw new ShareError(400, 'file_too_many', { path: paths[0] });
    return { items: outer, flagged: [...new Set(flagged)] };
  }

  private writeSnapshot(tx: Tx, linkId: string, position: number, files: FolderFile[]) {
    tx.delete(folderSnapshots)
      .where(and(eq(folderSnapshots.linkId, linkId), eq(folderSnapshots.position, position)))
      .run();
    for (let start = 0; start < files.length; start += SNAPSHOT_CHUNK) {
      tx.insert(folderSnapshots)
        .values(
          files.slice(start, start + SNAPSHOT_CHUNK).map((file) => ({
            linkId,
            position,
            relative: file.relative,
            size: file.size,
            modifiedAt: file.modifiedAt,
          })),
        )
        .run();
    }
  }

  /** Every link, or with `owner` only those that token created. */
  list(owner?: string): LinkSummary[] {
    const rows = this.db
      .select()
      .from(links)
      .where(owner === undefined ? undefined : eq(links.tokenId, owner))
      .orderBy(desc(links.createdAt))
      .all();
    const counts = this.counts();
    return rows.map((row) => this.summarize(row, this.inspect(row), counts.get(row.id)));
  }

  detail(id: string, owner?: string): LinkDetail {
    const row = this.row(id, owner);
    const content = this.inspect(row);
    const summary = this.summarize(row, content, this.counts(id).get(id));
    const history = this.db
      .select()
      .from(events)
      .where(eq(events.linkId, id))
      .orderBy(desc(events.at), desc(events.id))
      .limit(500)
      .all();
    return {
      ...summary,
      url: this.url(row),
      changes: content.changes.slice(0, MAX_CHANGES),
      version: content.version,
      // Looked up now rather than stored, so older activity gets a provider too once the table is there.
      events: history.map(({ linkId: _, ...event }): EventView => ({ ...event, provider: this.providerOf(event.ip) })),
    };
  }

  async update(id: string, input: UpdateLinkBody): Promise<LinkDetail> {
    const patch = updateLinkBody.parse(input);
    const row = this.row(id);
    const accept = patch.acceptChanges
      ? this.prepareAccept(row, patch.acceptChanges, patch.confirmSensitive ?? false)
      : null;
    const changes: Partial<LinkRow> = {};
    if (patch.label !== undefined) changes.label = patch.label;
    if (patch.expiresAt !== undefined) changes.expiresAt = patch.expiresAt;
    if (patch.maxDownloads !== undefined) changes.maxDownloads = patch.maxDownloads;
    if (patch.onChange !== undefined) changes.onChange = patch.onChange;
    if (patch.allowedNetworks !== undefined)
      changes.allowedNetworks = patch.allowedNetworks.length ? patch.allowedNetworks : null;
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
      accept?.(tx);
    });
    this.revision++;
    return this.detail(id);
  }

  /**
   * What is on disk now becomes what the link shares; items that are gone leave the link. Only the version the
   * owner looked at is accepted: anything that appeared since, or a file now on the sensitive list, is refused.
   */
  private prepareAccept(link: LinkRow, version: string, confirmSensitive: boolean): (tx: Tx) => void {
    const content = this.inspect(link);
    if (content.version !== version) throw new ShareError(409, 'changes_moved');
    const writes: ((tx: Tx) => void)[] = [];
    const flagged: string[] = [];
    try {
      for (const { item, state } of content.items) {
        const where = and(eq(linkFiles.linkId, link.id), eq(linkFiles.position, item.position));
        if (state === 'ok') continue;
        if (state === 'missing') {
          writes.push((tx) => {
            tx.delete(linkFiles).where(where).run();
            tx.delete(folderSnapshots)
              .where(and(eq(folderSnapshots.linkId, link.id), eq(folderSnapshots.position, item.position)))
              .run();
          });
        } else if (item.kind === 'file') {
          const current = this.storage.file(item.path);
          if (this.sensitive.matches(current, current.absolute)) flagged.push(current.path);
          writes.push((tx) =>
            tx.update(linkFiles).set({ size: current.size, modifiedAt: current.modifiedAt }).where(where).run(),
          );
        } else {
          const { files } = folderSnapshot(this.content, item.path, false);
          const size = files.reduce((sum, file) => sum + file.size, 0);
          writes.push((tx) => {
            this.writeSnapshot(tx, link.id, item.position, files);
            tx.update(linkFiles).set({ size }).where(where).run();
          });
        }
      }
    } catch (error) {
      if (error instanceof StorageError) throw new ShareError(409, 'changes_moved');
      throw error;
    }
    if (flagged.length && !confirmSensitive) throw new ShareError(409, 'sensitive', { files: flagged });
    return (tx) => {
      for (const write of writes) write(tx);
    };
  }

  remove(id: string, owner?: string) {
    this.row(id, owner);
    this.db.delete(links).where(eq(links.id, id)).run();
    this.revision++;
  }

  activeCount(): number {
    return this.list().filter((link) => link.state === 'active').length;
  }

  /**
   * Links that their own settings still allow and that still point at something on disk, without walking
   * folders or comparing files: cheap enough to answer for every public request, which is all the switch needs.
   */
  openCount(): number {
    const now = Date.now();
    const rows = this.db
      .select({ id: links.id })
      .from(links)
      .where(and(eq(links.active, true), isNull(links.lockedAt), or(isNull(links.expiresAt), gt(links.expiresAt, now))))
      .all();
    // A link at its limit stays open: the people who already downloaded may still come back for the files.
    return rows.filter((row) => {
      const items = this.db.select({ path: linkFiles.path }).from(linkFiles).where(eq(linkFiles.linkId, row.id)).all();
      return items.some((item) => this.storage.exists(item.path));
    }).length;
  }

  find(id: string): LinkRow | undefined {
    return this.db.select().from(links).where(eq(links.id, id)).get();
  }

  /** True when the caller derived the proof from the link key, i.e. holds the whole link and not only its id. */
  holdsKey(link: LinkRow, proof: string | undefined): boolean {
    return !!proof && safeEqual(proof, keyProof(this.vault.open(link.sealedKey, link.id), link.id));
  }

  /** Whether the link may be opened from this address: always, unless it lists the networks it allows. */
  allowsNetwork(link: LinkRow, ip: string | null | undefined): boolean {
    return !link.allowedNetworks?.length || isAllowed(allowList(link.allowedNetworks), ip);
  }

  /** Changes whenever the password is set, changed or removed, so older tickets stop working. */
  passwordGeneration(link: LinkRow): string {
    return sha256(link.passwordHash ?? '').slice(0, 12);
  }

  /**
   * What the broker may serve right now to this visitor, or why not. A link whose limit is reached keeps
   * serving the people who already got the files: they may retry or fetch the other files. The network
   * comes first, so someone outside the allowed ones learns nothing about the link's state.
   */
  servable(
    id: string,
    { visitor, ip }: Pick<Visit, 'visitor' | 'ip'>,
  ): { ok: true; value: ServableLink } | { ok: false; reason: RefusalReason | 'not_found' } {
    const link = this.db.select().from(links).where(eq(links.id, id)).get();
    if (!link) return { ok: false, reason: 'not_found' };
    if (!this.allowsNetwork(link, ip)) return { ok: false, reason: 'network' };
    const content = this.inspect(link);
    const counts = this.counts(id).get(id) ?? EMPTY_COUNTS;
    const state = this.stateOf(link, content, counts, !!visitor && this.isRecipient(id, visitor));
    if (state !== 'active') return { ok: false, reason: state };
    return { ok: true, value: { link, content, counts, key: this.vault.open(link.sealedKey, id) } };
  }

  record(linkId: string, event: NewEvent) {
    this.db
      .insert(events)
      .values({
        linkId,
        at: Date.now(),
        type: event.type,
        file: event.file ?? null,
        path: event.path?.slice(0, 1024) ?? null,
        downloadId: event.downloadId ?? null,
        ip: event.ip ?? null,
        country: event.country ?? null,
        userAgent: event.userAgent?.slice(0, 512) ?? null,
        language: event.language?.slice(0, 128) ?? null,
        visitor: event.visitor ?? null,
        bytes: event.bytes ?? null,
        detail: event.detail?.slice(0, 256) ?? null,
        counted: event.counted ?? false,
      })
      .run();
    this.onEvent?.(
      linkId,
      event,
      () => this.db.select({ label: links.label }).from(links).where(eq(links.id, linkId)).get()?.label ?? null,
    );
  }

  private startedDownload(linkId: string, downloadId: string) {
    return this.db
      .select({ file: events.file, path: events.path, visitor: events.visitor })
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

  /** Whether this visitor started this download (only they may report how it ended). */
  startedBy(linkId: string, downloadId: string, visitor: string | null | undefined): boolean {
    const started = this.startedDownload(linkId, downloadId);
    return started !== undefined && !!visitor && started.visitor === visitor;
  }

  downloadTarget(linkId: string, downloadId: string): { file: number | null; path: string | null } {
    const started = this.startedDownload(linkId, downloadId);
    return { file: started?.file ?? null, path: started?.path ?? null };
  }

  /** Counts a wrong password; returns true when the link just got locked. */
  failPassword(link: LinkRow, visit: Visit): boolean {
    this.record(link.id, { ...visit, type: 'password_failed' });
    // Incremented in SQL, not from the row read before the password check: parallel attempts must all count.
    const updated = this.db
      .update(links)
      .set({ failedPasswords: sql`${links.failedPasswords} + 1` })
      .where(eq(links.id, link.id))
      .returning({ failures: links.failedPasswords, lockedAt: links.lockedAt })
      .get();
    const failures = updated?.failures ?? 0;
    const lock = failures >= this.maxPasswordFailures && !updated?.lockedAt;
    if (lock) {
      this.db.update(links).set({ lockedAt: Date.now() }).where(eq(links.id, link.id)).run();
      this.record(link.id, { ...visit, type: 'locked', detail: `${failures} wrong passwords` });
      this.revision++;
    }
    return lock;
  }

  unlocked(link: LinkRow, visit: Visit) {
    this.record(link.id, { ...visit, type: 'unlocked' });
    if (link.failedPasswords > 0) this.db.update(links).set({ failedPasswords: 0 }).where(eq(links.id, link.id)).run();
  }

  /** A token asking for a link it did not create gets the same answer as for one that does not exist. */
  private row(id: string, owner?: string): LinkRow {
    const row = this.db.select().from(links).where(eq(links.id, id)).get();
    if (!row || (owner !== undefined && row.tokenId !== owner)) throw new ShareError(404, 'not_found');
    return row;
  }

  private inspect(link: LinkRow): Inspection {
    const items = this.db
      .select()
      .from(linkFiles)
      .where(eq(linkFiles.linkId, link.id))
      .orderBy(linkFiles.position)
      .all();
    const snapshots: Snapshot[] = items.some((item) => item.kind === 'folder')
      ? this.db.select().from(folderSnapshots).where(eq(folderSnapshots.linkId, link.id)).all()
      : [];
    return inspect(items, snapshots, link.onChange, this.content);
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
        downloads: sql<number>`count(distinct case when ${events.counted} then ${events.downloadId} end)`,
        recipients: sql<number>`count(distinct case when ${events.counted} then ${events.visitor} end)`,
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

  /** Whether this visitor already got the files of this link once. */
  isRecipient(linkId: string, visitor: string): boolean {
    const row = this.db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.linkId, linkId), eq(events.visitor, visitor), eq(events.counted, true)))
      .get();
    return row !== undefined;
  }

  private stateOf(link: LinkRow, content: Inspection, counts: LinkCounts, recipient = false): LinkState {
    if (link.lockedAt) return 'locked';
    if (!link.active) return 'disabled';
    if (link.expiresAt && link.expiresAt <= Date.now()) return 'expired';
    // The limit counts people (visitors) who got the files, so whoever already did can always retry.
    if (link.maxDownloads && counts.recipients >= link.maxDownloads && !recipient) return 'exhausted';
    const present = content.items.some((item) => item.state !== 'missing');
    if (link.onChange === 'pause' && content.changed && present) return 'paused';
    if (content.entries.length === 0) return 'unavailable';
    return 'active';
  }

  private summarize(
    row: LinkRow,
    content: Inspection,
    counts: (LinkCounts & { lastActivityAt: number | null }) | undefined,
  ): LinkSummary {
    const { lastActivityAt, ...linkCounts } = counts ?? { ...EMPTY_COUNTS, lastActivityAt: null };
    return {
      id: row.id,
      label: row.label,
      state: this.stateOf(row, content, linkCounts),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      maxDownloads: row.maxDownloads,
      hasPassword: row.passwordHash !== null,
      onChange: row.onChange,
      allowedNetworks: row.allowedNetworks ?? [],
      createdBy: row.createdBy,
      items: content.items.map(({ item, name, state, changes, size, fileCount }) => ({
        position: item.position,
        kind: item.kind,
        path: item.path,
        name,
        size,
        fileCount,
        state,
        changes,
      })),
      counts: linkCounts,
      lastActivityAt,
    };
  }
}
