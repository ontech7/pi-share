import { asc, eq } from 'drizzle-orm';
import {
  type CreatedToken,
  type CreateTokenBody,
  createTokenBody,
  MAX_TOKENS,
  TOKEN_PREFIX,
  type TokenView,
} from '../shared/api.ts';
import { randomId, sha256 } from './crypto.ts';
import { type Db, schema } from './db/index.ts';
import { ShareError } from './shares.ts';

const { tokens } = schema;

const TOKEN_FORMAT = new RegExp(`^${TOKEN_PREFIX}[\\w-]{43}$`);
/** "Last used" is a hint, not a log: one write a minute at most, the database sits on an SD card. */
const LAST_USED_EVERY = 60_000;

export type TokenOwner = { id: string; name: string };

/** Integration tokens: what a program holds to create and manage its own links, without the admin password. */
export class Tokens {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  list(): TokenView[] {
    return this.db
      .select()
      .from(tokens)
      .orderBy(asc(tokens.createdAt))
      .all()
      .map(({ tokenHash: _, ...view }) => view);
  }

  create(input: CreateTokenBody): CreatedToken {
    const body = createTokenBody.parse(input);
    if (this.list().length >= MAX_TOKENS) throw new ShareError(409, 'too_many_tokens');
    const token = `${TOKEN_PREFIX}${randomId(32)}`;
    const view: TokenView = {
      id: randomId(9),
      name: body.name,
      hint: token.slice(-4),
      createdAt: Date.now(),
      expiresAt: body.expiresAt,
      lastUsedAt: null,
    };
    this.db
      .insert(tokens)
      .values({ ...view, tokenHash: sha256(token) })
      .run();
    return { ...view, token };
  }

  remove(id: string) {
    const removed = this.db.delete(tokens).where(eq(tokens.id, id)).returning({ id: tokens.id }).all();
    if (!removed.length) throw new ShareError(404, 'not_found');
  }

  /** Who holds this token, or null when it is malformed, unknown or expired. */
  verify(token: string): TokenOwner | null {
    if (!TOKEN_FORMAT.test(token)) return null;
    const row = this.db
      .select()
      .from(tokens)
      .where(eq(tokens.tokenHash, sha256(token)))
      .get();
    const now = Date.now();
    if (!row || (row.expiresAt !== null && row.expiresAt <= now)) return null;
    if (row.lastUsedAt === null || now - row.lastUsedAt >= LAST_USED_EVERY)
      this.db.update(tokens).set({ lastUsedAt: now }).where(eq(tokens.id, row.id)).run();
    return { id: row.id, name: row.name };
  }
}
