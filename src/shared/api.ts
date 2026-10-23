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
/** Why a link refuses someone holding its key: its state, or a network outside the ones it allows. */
export type RefusalReason = LinkState | 'network';
export type FileState = 'ok' | 'changed' | 'missing';

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** IPv6 in its canonical form, through the URL parser so browser and server agree on what is valid. */
function canonicalIPv6(value: string): string | null {
  if (!value.includes(':') || !/^[\da-f:.]+$/i.test(value)) return null;
  try {
    return new URL(`http://[${value}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

/** "203.0.113.7", "203.0.113.0/24" or "2001:db8::/48" in canonical form, or null when it is not one. */
export function parseNetwork(input: string): string | null {
  const [address = '', prefix, extra] = input.trim().split('/');
  if (extra !== undefined || (prefix !== undefined && !/^\d{1,3}$/.test(prefix))) return null;
  if (IPV4.test(address)) {
    const bits = prefix === undefined ? 32 : Number(prefix);
    return bits <= 32 ? `${address}/${bits}` : null;
  }
  const v6 = canonicalIPv6(address);
  if (!v6) return null;
  const bits = prefix === undefined ? 128 : Number(prefix);
  return bits <= 128 ? `${v6}/${bits}` : null;
}

export const MAX_NETWORKS = 32;
const network = z
  .string()
  .max(64)
  .refine((value) => parseNetwork(value) !== null, 'invalid_network')
  .transform((value) => parseNetwork(value) as string);
const networks = z.array(network).max(MAX_NETWORKS);

export const createLinkBody = z.object({
  paths: z.array(z.string().min(1).max(4096)).min(1).max(100),
  label: z.string().trim().max(120).default(''),
  password: z.string().min(4).max(256).optional(),
  /** Left out, it comes from the saved defaults for new links; null never expires. */
  expiresAt: z.number().int().positive().nullable().optional(),
  /** Left out, it comes from the saved defaults for new links; null means no limit. */
  maxDownloads: z.number().int().min(1).max(10_000).nullable().optional(),
  onChange: z.enum(changePolicies).optional(),
  /** Networks the link may be opened from; empty means any. */
  allowedNetworks: networks.default([]),
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
  allowedNetworks: networks.optional(),
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

export const TOKEN_PREFIX = 'pis_';
export const MAX_TOKENS = 20;
export const createTokenBody = z.object({
  name: z.string().trim().min(1).max(60),
  /** Null never expires. */
  expiresAt: z
    .number()
    .int()
    .positive()
    .nullable()
    .refine((value) => value === null || value > Date.now(), 'in_the_past'),
});
export type CreateTokenBody = z.input<typeof createTokenBody>;

export type TokenView = {
  id: string;
  name: string;
  hint: string;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
};
/** The token itself travels only in this answer, once. */
export type CreatedToken = TokenView & { token: string };

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
  allowedNetworks: string[];
  /** The integration token that created the link, by the name it had then. */
  createdBy: string | null;
  items: LinkItemView[];
  counts: LinkCounts;
  lastActivityAt: number | null;
};

/** Who runs the network an address belongs to; `hosting` marks clouds, servers and VPN exits. */
export type Provider = { asn: number; name: string; hosting: boolean };

export type ProviderInfo = {
  enabled: boolean;
  /** Address ranges in the table on disk, 0 until the first download. */
  ranges: number;
  updatedAt: number | null;
  error: RemoteError | null;
  updating: boolean;
};
export const providersBody = z.object({ enabled: z.boolean() });

export const notificationKinds = ['opens', 'downloads', 'warnings', 'previews'] as const;
export type NotificationKind = (typeof notificationKinds)[number];
export const notificationChannels = ['ntfy', 'telegram', 'email'] as const;
export type NotificationChannel = (typeof notificationChannels)[number];
export const notificationLangs = ['en', 'it'] as const;
export const smtpSecurity = ['tls', 'starttls', 'none'] as const;

/** Why talking to an outside server failed, as a code the admin translates and, at most, the server's words. */
export const remoteErrorCodes = [
  'status',
  'rejected',
  'auth',
  'unreachable',
  'timeout',
  'too_large',
  'invalid',
] as const;
export type RemoteError = { code: (typeof remoteErrorCodes)[number]; detail: string | null };

export type ChannelStatus = { lastSentAt: number | null; lastError: RemoteError | null };

/** What the admin sees: secrets only as "one is saved". */
export type NotificationSettings = {
  kinds: Record<NotificationKind, boolean>;
  lang: (typeof notificationLangs)[number];
  ntfy: { enabled: boolean; server: string; topic: string; hasToken: boolean };
  telegram: { enabled: boolean; chatId: string; hasToken: boolean };
  email: {
    enabled: boolean;
    host: string;
    port: number;
    security: (typeof smtpSecurity)[number];
    user: string;
    hasPassword: boolean;
    from: string;
    to: string;
  };
  status: Record<NotificationChannel, ChannelStatus>;
};

/** A new secret, or null to forget the one saved. */
const secret = (max: number) => z.string().trim().min(1).max(max).nullable();

export const notificationsBody = z.object({
  kinds: z
    .object({ opens: z.boolean(), downloads: z.boolean(), warnings: z.boolean(), previews: z.boolean() })
    .partial()
    .optional(),
  lang: z.enum(notificationLangs).optional(),
  ntfy: z
    .object({
      enabled: z.boolean(),
      // Origin and path only: credentials in the address would be stored and shown in clear.
      server: z
        .url({ protocol: /^https?$/ })
        .max(200)
        .refine((value) => {
          // Zod runs this even when the URL check above failed.
          if (!URL.canParse(value) || /[?#]/.test(value)) return false;
          const url = new URL(value);
          return !url.username && !url.password;
        }, 'origin_and_path_only'),
      topic: z.string().regex(/^[\w-]{1,64}$/),
      token: secret(200),
    })
    .partial()
    .optional(),
  telegram: z
    .object({
      enabled: z.boolean(),
      /** A numeric chat id (negative for groups) or a public channel's @name. */
      chatId: z
        .string()
        .trim()
        .regex(/^(-?\d{1,20}|@\w{5,32})$/),
      token: z
        .string()
        .trim()
        .regex(/^\d{1,20}:[\w-]{20,100}$/)
        .nullable(),
    })
    .partial()
    .optional(),
  email: z
    .object({
      enabled: z.boolean(),
      host: z
        .string()
        .trim()
        .regex(/^[a-z\d]([a-z\d.-]{0,251}[a-z\d])?$/i),
      port: z.number().int().min(1).max(65_535),
      security: z.enum(smtpSecurity),
      user: z.string().trim().max(254),
      password: secret(256),
      from: z.email().max(254),
      to: z.email().max(254),
    })
    .partial()
    .optional(),
});
export type NotificationsBody = z.input<typeof notificationsBody>;
export const notificationTestBody = z.object({ channel: z.enum(notificationChannels) });

export type EventView = {
  id: number;
  at: number;
  type: EventType;
  file: number | null;
  path: string | null;
  downloadId: string | null;
  ip: string | null;
  country: string | null;
  provider: Provider | null;
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
