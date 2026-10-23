import path from 'node:path';
import { buildAdmin, generateSetupCode } from '../admin.ts';
import { buildBroker } from '../broker.ts';
import { loadConfig } from '../config.ts';
import { loadOrCreateKey, Vault } from '../crypto.ts';
import { openDatabase } from '../db/index.ts';
import { closeOnSignal, listen, readSecret } from '../listen.ts';
import { Notifier } from '../notify.ts';
import { Providers } from '../providers.ts';
import { SensitiveList } from '../sensitive.ts';
import { Settings } from '../settings.ts';
import { Shares } from '../shares.ts';
import { Storage } from '../storage.ts';
import { currentVersion, githubLatest, Updates } from '../updates.ts';

const config = loadConfig();
const db = openDatabase(config.dbFile);
const vault = new Vault(loadOrCreateKey(config.masterKeyFile));
const storage = new Storage(config.storageRoot, config.deny, config.hideSystem);
const settings = new Settings(db);
const version = currentVersion();
const providers = new Providers({
  file: config.providerFile,
  url: config.providerDataUrl,
  settings,
  enabledDefault: config.providerLookup,
  userAgent: `pi-share/${version}`,
});
const notifier = new Notifier({
  settings,
  vault,
  providerOf: (ip) => providers.lookup(ip),
  lang: config.lang || 'en',
});
const shares = new Shares({
  db,
  storage,
  vault,
  sensitive: new SensitiveList(config.sensitiveFile),
  publicUrl: config.publicUrl,
  maxPasswordFailures: config.maxPasswordFailures,
  providerOf: (ip) => providers.lookup(ip),
  onEvent: (link, event) => notifier.onEvent(link, event),
});

const updates = new Updates({
  current: version,
  fetchLatest: githubLatest(config.updateRepo, `pi-share/${version}`),
  settings,
  autoCheckDefault: config.updateCheck,
  requestDir: config.updateRequestDir,
  statusDir: config.updateStatusDir,
});
setTimeout(() => updates.maybeCheck(), 10_000).unref();
setInterval(() => updates.maybeCheck(), 60 * 60 * 1000).unref();
setTimeout(() => void providers.start(), 15_000).unref();
setInterval(() => void providers.maybeRefresh(), 6 * 60 * 60 * 1000).unref();

const setupCode = settings.hasAdminPassword() ? null : generateSetupCode();
if (setupCode) console.log(`pi-share: no admin password yet, open the admin and use the setup code ${setupCode}`);

const admin = await buildAdmin({
  config,
  shares,
  settings,
  storage,
  updates,
  providers,
  notifier,
  setupCode,
  staticRoot: path.resolve(import.meta.dirname, '../../../dist/admin'),
});
const broker = buildBroker({ shares, settings, storage, vault, secret: readSecret(config.brokerSecretFile) });

const prune = () => shares.pruneEvents(config.eventRetentionDays);
prune();
setInterval(prune, 24 * 60 * 60 * 1000).unref();

await listen(broker, config.brokerListen);
await listen(admin, config.adminListen);
closeOnSignal(admin, broker);
console.log(`pi-share ${version} admin on ${config.adminListen}, broker on ${config.brokerListen}`);
