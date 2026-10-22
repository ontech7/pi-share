import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { eventTypes } from '../../shared/api.ts';

export const links = sqliteTable('links', {
  id: text().primaryKey(),
  label: text().notNull().default(''),
  sealedKey: text('sealed_key').notNull(),
  passwordHash: text('password_hash'),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at'),
  maxDownloads: integer('max_downloads'),
  active: integer({ mode: 'boolean' }).notNull().default(true),
  lockedAt: integer('locked_at'),
  failedPasswords: integer('failed_passwords').notNull().default(0),
});

export const linkFiles = sqliteTable(
  'link_files',
  {
    linkId: text('link_id')
      .notNull()
      .references(() => links.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    path: text().notNull(),
    name: text().notNull(),
    size: integer().notNull(),
    modifiedAt: integer('modified_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.linkId, table.position] })],
);

export const events = sqliteTable(
  'events',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    linkId: text('link_id')
      .notNull()
      .references(() => links.id, { onDelete: 'cascade' }),
    at: integer().notNull(),
    type: text({ enum: eventTypes }).notNull(),
    file: integer(),
    downloadId: text('download_id'),
    ip: text(),
    country: text(),
    userAgent: text('user_agent'),
    language: text(),
    visitor: text(),
    bytes: integer(),
    detail: text(),
  },
  (table) => [index('events_link_at').on(table.linkId, table.at)],
);

export const sessions = sqliteTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

export const settings = sqliteTable('settings', {
  key: text().primaryKey(),
  value: text().notNull(),
});
