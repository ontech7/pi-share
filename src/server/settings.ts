import crypto from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import { type Preferences, preferencesSchema } from '../shared/api.ts';
import { hashSecret, sha256, verifySecret } from './crypto.ts';
import { type Db, schema } from './db/index.ts';

const { settings, sessions } = schema;

export type ServiceSettings = { enabled: boolean; autoOff: boolean };

const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;

export class Settings {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private get<T>(key: string, fallback: T): T {
    const row = this.db.select().from(settings).where(eq(settings.key, key)).get();
    return row ? (JSON.parse(row.value) as T) : fallback;
  }

  private set(key: string, value: unknown) {
    const json = JSON.stringify(value);
    this.db
      .insert(settings)
      .values({ key, value: json })
      .onConflictDoUpdate({ target: settings.key, set: { value: json } })
      .run();
  }

  service(): ServiceSettings {
    return this.get('service', { enabled: true, autoOff: true });
  }

  updateService(patch: Partial<ServiceSettings>): ServiceSettings {
    const next = { ...this.service(), ...patch };
    this.set('service', next);
    return next;
  }

  /** Defaults for new links; a stored value that no longer fits the schema falls back field by field. */
  preferences(defaults: Preferences): Preferences {
    const stored = this.get<Record<string, unknown>>('preferences', {});
    const merged = { ...defaults };
    for (const key of Object.keys(defaults) as (keyof Preferences)[]) {
      const field = preferencesSchema.shape[key].safeParse(stored[key]);
      if (field.success) Object.assign(merged, { [key]: field.data });
    }
    return merged;
  }

  updatePreferences(patch: Partial<Preferences>, defaults: Preferences): Preferences {
    const next = { ...this.preferences(defaults), ...patch };
    this.set('preferences', next);
    return next;
  }

  updates(autoCheckDefault: boolean): { autoCheck: boolean } {
    const stored = this.get<{ autoCheck?: unknown }>('updates', {});
    return { autoCheck: typeof stored.autoCheck === 'boolean' ? stored.autoCheck : autoCheckDefault };
  }

  setUpdates(value: { autoCheck: boolean }) {
    this.set('updates', value);
  }

  providers(enabledDefault: boolean): { enabled: boolean } {
    const stored = this.get<{ enabled?: unknown }>('providers', {});
    return { enabled: typeof stored.enabled === 'boolean' ? stored.enabled : enabledDefault };
  }

  setProviders(value: { enabled: boolean }) {
    this.set('providers', value);
  }

  notifications<T>(): T | null {
    return this.get<T | null>('notifications', null);
  }

  setNotifications(value: unknown) {
    this.set('notifications', value);
  }

  hasAdminPassword(): boolean {
    return this.get<string | null>('adminPasswordHash', null) !== null;
  }

  async setAdminPassword(password: string) {
    this.set('adminPasswordHash', await hashSecret(password));
    this.db.delete(sessions).run();
  }

  checkAdminPassword(password: string): Promise<boolean> {
    return verifySecret(this.get<string | null>('adminPasswordHash', null), password);
  }

  createSession(): { token: string; expiresAt: number } {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.db.delete(sessions).where(lt(sessions.expiresAt, now)).run();
    this.db
      .insert(sessions)
      .values({ tokenHash: sha256(token), createdAt: now, expiresAt: now + SESSION_TTL })
      .run();
    return { token, expiresAt: now + SESSION_TTL };
  }

  isValidSession(token: string | undefined): boolean {
    if (!token) return false;
    const row = this.db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, sha256(token)))
      .get();
    return !!row && row.expiresAt > Date.now();
  }

  endSession(token: string | undefined) {
    if (token)
      this.db
        .delete(sessions)
        .where(eq(sessions.tokenHash, sha256(token)))
        .run();
  }
}
