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

export type LinkState = 'active' | 'disabled' | 'expired' | 'locked' | 'exhausted' | 'unavailable';
export type FileState = 'ok' | 'changed' | 'missing';

export const createLinkBody = z.object({
  files: z.array(z.string().min(1).max(4096)).min(1).max(100),
  label: z.string().trim().max(120).default(''),
  password: z.string().min(4).max(256).optional(),
  expiresAt: z.number().int().positive().nullable().default(null),
  maxDownloads: z.number().int().min(1).max(10_000).nullable().default(null),
  confirmSensitive: z.boolean().default(false),
});
export type CreateLinkBody = z.input<typeof createLinkBody>;

export const updateLinkBody = z.object({
  label: z.string().trim().max(120).optional(),
  active: z.boolean().optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
  maxDownloads: z.number().int().min(1).max(10_000).nullable().optional(),
  password: z.string().min(4).max(256).nullable().optional(),
  acceptChanges: z.literal(true).optional(),
});
export type UpdateLinkBody = z.input<typeof updateLinkBody>;

export const serviceBody = z.object({ enabled: z.boolean().optional(), autoOff: z.boolean().optional() });
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

export type LinkFileView = { position: number; path: string; name: string; size: number; state: FileState };

export type LinkCounts = {
  opens: number;
  started: number;
  downloads: number;
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
  files: LinkFileView[];
  counts: LinkCounts;
  lastActivityAt: number | null;
};

export type EventView = {
  id: number;
  at: number;
  type: EventType;
  file: number | null;
  downloadId: string | null;
  ip: string | null;
  country: string | null;
  userAgent: string | null;
  language: string | null;
  visitor: string | null;
  bytes: number | null;
  detail: string | null;
};

export type LinkDetail = LinkSummary & { url: string; events: EventView[] };

export type SensitiveConflict = { error: 'sensitive'; files: string[] };

/** What the recipient's browser decrypts: never readable by the edge or anything in between. */
export type ShareMeta = {
  files: { name: string; size: number; available: boolean }[];
  bundle: { name: string; size: number } | null;
  expiresAt: number | null;
};
