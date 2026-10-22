import path from 'node:path';
import { buildAdmin, generateSetupCode } from '../admin.ts';
import { buildBroker } from '../broker.ts';
import { loadConfig } from '../config.ts';
import { loadOrCreateKey, Vault } from '../crypto.ts';
import { openDatabase } from '../db/index.ts';
import { closeOnSignal, listen, readSecret } from '../listen.ts';
import { SensitiveList } from '../sensitive.ts';
import { Settings } from '../settings.ts';
import { Shares } from '../shares.ts';
import { Storage } from '../storage.ts';

const config = loadConfig();
const db = openDatabase(config.dbFile);
const vault = new Vault(loadOrCreateKey(config.masterKeyFile));
const storage = new Storage(config.storageRoot, config.deny, config.hideSystem);
const settings = new Settings(db);
const shares = new Shares({
  db,
  storage,
  vault,
  sensitive: new SensitiveList(config.sensitiveFile),
  publicUrl: config.publicUrl,
  maxPasswordFailures: config.maxPasswordFailures,
});

const setupCode = settings.hasAdminPassword() ? null : generateSetupCode();
if (setupCode) console.log(`pi-share: no admin password yet, open the admin and use the setup code ${setupCode}`);

const admin = await buildAdmin({
  config,
  shares,
  settings,
  storage,
  setupCode,
  staticRoot: path.resolve(import.meta.dirname, '../../../dist/admin'),
});
const broker = buildBroker({ shares, settings, storage, vault, secret: readSecret(config.brokerSecretFile) });

await listen(broker, config.brokerListen);
await listen(admin, config.adminListen);
closeOnSignal(admin, broker);
console.log(`pi-share admin on ${config.adminListen}, broker on ${config.brokerListen}`);
