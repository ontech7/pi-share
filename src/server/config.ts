import path from 'node:path';
import { z } from 'zod';

const list = (fallback = '') =>
  z
    .string()
    .default(fallback)
    .transform((value) =>
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    );

const flag = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === '' ? fallback : /^(1|true|yes|on)$/i.test(value)));

const PRIVATE_NETWORKS = '127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,::1/128,fc00::/7';

const schema = z
  .object({
    STORAGE_ROOT: z.string().default('/storage'),
    DATA_DIR: z.string().default('/data'),
    PUBLIC_URL: z.url().default('http://localhost:8787'),
    ADMIN_LISTEN: z.string().default('0.0.0.0:8080'),
    BROKER_LISTEN: z.string().default('127.0.0.1:8081'),
    BROKER_URL: z.string().default('127.0.0.1:8081'),
    PUBLIC_LISTEN: z.string().default('127.0.0.1:8787'),
    BROKER_SECRET_FILE: z.string().default(''),
    DENY_PATHS: list(),
    HIDE_SYSTEM: flag(true),
    SENSITIVE_FILE: z.string().default(''),
    CLIENT_IP_HEADER: z.string().default('cf-connecting-ip'),
    COUNTRY_HEADER: z.string().default('cf-ipcountry'),
    ADMIN_ALLOW: list(PRIVATE_NETWORKS),
    TRUSTED_PROXIES: list(PRIVATE_NETWORKS),
    ADMIN_LANG: z.enum(['', 'en', 'it']).default(''),
    DEFAULT_EXPIRY_DAYS: z.coerce.number().int().min(0).max(3650).default(7),
    MAX_PASSWORD_FAILURES: z.coerce.number().int().min(1).max(1000).default(10),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']).default('info'),
  })
  .transform((env) => ({
    storageRoot: path.resolve(env.STORAGE_ROOT),
    dataDir: env.DATA_DIR,
    dbFile: path.join(env.DATA_DIR, 'share.db'),
    masterKeyFile: path.join(env.DATA_DIR, 'master.key'),
    publicUrl: env.PUBLIC_URL.replace(/\/+$/, ''),
    adminListen: env.ADMIN_LISTEN,
    brokerListen: env.BROKER_LISTEN,
    brokerUrl: env.BROKER_URL,
    publicListen: env.PUBLIC_LISTEN,
    brokerSecretFile: env.BROKER_SECRET_FILE,
    deny: env.DENY_PATHS.map((entry) => entry.replace(/^\/+|\/+$/g, '').toLowerCase()),
    hideSystem: env.HIDE_SYSTEM,
    sensitiveFile: env.SENSITIVE_FILE,
    clientIpHeader: env.CLIENT_IP_HEADER.toLowerCase(),
    countryHeader: env.COUNTRY_HEADER.toLowerCase(),
    adminAllow: env.ADMIN_ALLOW,
    trustedProxies: env.TRUSTED_PROXIES,
    lang: env.ADMIN_LANG,
    defaultExpiryDays: env.DEFAULT_EXPIRY_DAYS,
    maxPasswordFailures: env.MAX_PASSWORD_FAILURES,
    logLevel: env.LOG_LEVEL,
  }));

export type Config = z.output<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return schema.parse(env);
}

/** "unix:/run/x.sock" or "host:port" → Fastify listen options. */
export function listenOptions(address: string): { path: string } | { host: string; port: number } {
  if (address.startsWith('unix:')) return { path: address.slice(5) };
  const separator = address.lastIndexOf(':');
  return { host: address.slice(0, separator).replace(/^\[|\]$/g, ''), port: Number(address.slice(separator + 1)) };
}
