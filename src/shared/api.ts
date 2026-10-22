import { z } from 'zod';

export const eventTypes = [
  'preview',
  'open',
  'password_failed',
  'unlocked',
  'locked',
  'download_started',
  'download_finished',
  'download_aborted',
  'download_verified',
  'download_failed',
  'refused',
] as const;
export type EventType = (typeof eventTypes)[number];

export const changePolicies = ['pause', 'follow'] as const;
export type ChangePolicy = (typeof changePolicies)[number];
export const itemKinds = ['file', 'folder'] as const;
export type ItemKind = (typeof itemKinds)[number];

export type LinkState = 'active' | 'disabled' | 'expired' | 'locked' | 'exhausted' | 'paused' | 'unavailable';
export type FileState = 'ok' | 'changed' | 'missing';

export const createLinkBody = z.object({
  paths: z.array(z.string().min(1).max(4096)).min(1).max(100),
  label: z.string().trim().max(120).default(''),
  password: z.string().min(4).max(256).optional(),
  expiresAt: z.number().int().positive().nullable().default(null),
  maxDownloads: z.number().int().min(1).max(10_000).nullable().default(null),
  onChange: z.enum(changePolicies).optional(),
  confirmSensitive: z.boolean().default(false),
});
export type CreateLinkBody = z.input<typeof createLinkBody>;

export const updateLinkBody = z.object({
  label: z.string().trim().max(120).optional(),
  active: z.boolean().optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
  maxDownloads: z.number().int().min(1).max(10_000).nullable().optional(),
  password: z.string().min(4).max(256).nullable().optional(),
  onChange: z.enum(changePolicies).optional(),
  /** The `version` of the changes the owner looked at: anything newer is refused, not accepted blindly. */
  acceptChanges: z
    .string()
    .regex(/^[a-f0-9]{16}$/)
    .optional(),
  confirmSensitive: z.boolean().optional(),
});
export type UpdateLinkBody = z.input<typeof updateLinkBody>;

export const serviceBody = z.object({ enabled: z.boolean().optional(), autoOff: z.boolean().optional() });

export const preferencesSchema = z.object({
  onChange: z.enum(changePolicies),
  expiryDays: z.number().int().min(0).max(3650),
  maxDownloads: z.number().int().min(1).max(10_000).nullable(),
  generatePassword: z.boolean(),
});
export type Preferences = z.infer<typeof preferencesSchema>;
export const preferencesBody = preferencesSchema.partial();
export const updateStates = [
  'queued',
  'checking',
  'downloading',
  'backing_up',
  'restarting',
  'done',
  'failed',
  'rolled_back',
] as const;
export type UpdateState = (typeof updateStates)[number];
/** States after which the updater on the host is idle again. */
export const finalUpdateStates: readonly UpdateState[] = ['done', 'failed', 'rolled_back'];
export type UpdateStatus = { state: UpdateState; version: string; message: string | null; at: number };

export type ReleaseInfo = { version: string; notes: string; url: string; publishedAt: string | null };

export type UpdateInfo = {
  current: string;
  latest: ReleaseInfo | null;
  available: boolean;
  checkedAt: number | null;
  error: string | null;
  autoCheck: boolean;
  /** Whether an updater runs on the host, so the admin can ask it to install a release. */
  installable: boolean;
  status: UpdateStatus | null;
};

export const updateSettingsBody = z.object({ autoCheck: z.boolean() });
export const installUpdateBody = z.object({ version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/) });

export const passwordBody = z.object({ password: z.string().min(10).max(256) });
export const setupBody = passwordBody.extend({ code: z.string().min(1).max(64) });
export const loginBody = z.object({ password: z.string().min(1).max(256) });
export const changePasswordBody = z.object({
  current: z.string().min(1).max(256),
  password: z.string().min(10).max(256),
});

export type SessionState = { authenticated: boolean; needsSetup: boolean; lang: string };

export type ServiceState = {
  enabled: boolean;
  autoOff: boolean;
  online: boolean;
  activeLinks: number;
  publicUrl: string;
};

export type BrowseEntry = { name: string; path: string; type: 'dir' | 'file'; size: number; modifiedAt: number };
export type BrowseResult = { path: string; parent: string | null; entries: BrowseEntry[] };

export type ItemChanges = { added: number; removed: number; changed: number };

export type LinkItemView = {
  position: number;
  kind: ItemKind;
  path: string;
  name: string;
  size: number;
  fileCount: number;
  state: FileState;
  changes: ItemChanges | null;
};

export type ChangeView = { path: string; change: 'added' | 'removed' | 'changed' };

export type LinkCounts = {
  opens: number;
  started: number;
  downloads: number;
  /** Distinct visitors who got the files at least once: what the download limit counts. */
  recipients: number;
  verified: number;
  visitors: number;
  failedPasswords: number;
};

export type LinkSummary = {
  id: string;
  label: string;
  state: LinkState;
  createdAt: number;
  expiresAt: number | null;
  maxDownloads: number | null;
  hasPassword: boolean;
  onChange: ChangePolicy;
  items: LinkItemView[];
  counts: LinkCounts;
  lastActivityAt: number | null;
};

export type EventView = {
  id: number;
  at: number;
  type: EventType;
  file: number | null;
  path: string | null;
  downloadId: string | null;
  ip: string | null;
  country: string | null;
  userAgent: string | null;
  language: string | null;
  visitor: string | null;
  bytes: number | null;
  detail: string | null;
};

export type LinkDetail = LinkSummary & { url: string; changes: ChangeView[]; version: string; events: EventView[] };

export type SensitiveConflict = { error: 'sensitive'; files: string[] };

/** What the recipient's browser decrypts: never readable by the edge or anything in between. */
export type ShareMeta = {
  /** Files to show, by path inside the share ("Photos/2023/a.jpg"); the id is what a download asks for. */
  entries: { id: string; path: string; size: number }[];
  bundle: { name: string; size: number } | null;
  expiresAt: number | null;
};
