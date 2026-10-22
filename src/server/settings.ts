import crypto from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
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
