import { pipeline, type Readable } from 'node:stream';
import Fastify, { type FastifyReply } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ShareMeta } from '../shared/api.ts';
import type { Entry } from './content.ts';
import { encryptedSize, encryptStream, randomId, safeEqual, sealMeta, type Vault, verifySecret } from './crypto.ts';
import type { Settings } from './settings.ts';
import type { ServableLink, Shares, Visit } from './shares.ts';
import { type Storage, StorageError } from './storage.ts';
import { exactFile, zipSize, zipStream } from './zip.ts';

/** The edge passes what it knows about the visitor in this header, as JSON. */
export const VISIT_HEADER = 'x-visit';
export const TICKET_HEADER = 'x-ticket';
export const SECRET_HEADER = 'x-broker-secret';
export const DOWNLOAD_ID_HEADER = 'x-download-id';

const TICKET_TTL = 6 * 60 * 60 * 1000;
const MAX_DOWNLOADS = 16;
const MAX_DOWNLOADS_PER_LINK = 4;
const MAX_DOWNLOADS_PER_VISITOR = 2;
const IDLE_TIMEOUT = 60_000;
const ONLINE_CACHE = 2_000;
const PREVIEW_INTERVAL = 10_000;

const VISIT_LIMITS = { ip: 64, country: 8, userAgent: 512, language: 128, visitor: 64 } as const;

type Ticket = { l: string; v: string; g: string; exp: number };

const linkParams = z.object({ id: z.string().regex(/^[\w-]{10,64}$/) });
const proof = z.string().regex(/^[\w-]{43}$/);

export type BrokerDeps = {
  shares: Shares;
  settings: Settings;
  storage: Storage;
  vault: Vault;
  secret: string | null;
};

export function isOnline(shares: Shares, settings: Settings): boolean {
  const service = settings.service();
  return service.enabled && (!service.autoOff || shares.openCount() > 0);
}

/** Every field cut to size instead of rejected, so an oversized header cannot wipe the visitor from the log. */
export function visitOf(headers: Record<string, unknown>): Visit {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(String(headers[VISIT_HEADER] ?? '{}'));
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
  } catch {
    // keep the empty visit
  }
  const visit: Visit = {};
  for (const [field, limit] of Object.entries(VISIT_LIMITS) as [keyof Visit, number][]) {
    const value = raw[field];
    visit[field] = typeof value === 'string' && value ? value.slice(0, limit) : null;
  }
  return visit;
}

export function buildBroker({ shares, settings, storage, vault, secret }: BrokerDeps) {
  const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 16 * 1024 }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const perLink = new Map<string, number>();
  const checkingPassword = new Set<string>();
  const perVisitor = new Map<string, number>();
  const lastPreview = new Map<string, number>();
  let activeLinks = { value: 0, at: 0, revision: -1 };

  const adjust = (map: Map<string, number>, key: string, delta: number) => {
    const next = (map.get(key) ?? 0) + delta;
    if (next > 0) map.set(key, next);
    else map.delete(key);
  };

  app.addHook('onRequest', async (request, reply) => {
    if (secret && !safeEqual(String(request.headers[SECRET_HEADER] ?? ''), secret)) return reply.code(401).send();
  });

  const unavailable = (reply: FastifyReply, reason?: string) =>
    reply.code(404).send(reason ? { error: 'unavailable', reason } : { error: 'unavailable' });

  const metaOf = ({ link, content }: ServableLink): ShareMeta => {
    const { entries } = content;
    const folders = content.items.filter((report) => report.item.kind === 'folder');
    const bundled = entries.length > 1 || folders.length > 0;
    const fallback = folders.length === 1 && content.items.length === 1 ? (folders[0]?.name as string) : 'files';
    return {
      entries: entries.map(({ id, path, size }) => ({ id, path, size })),
      bundle: bundled
        ? {
            name: `${(link.label || fallback).replace(/[\\/:*?"<>|]+/g, '_')}.zip`,
            size: zipSize(entries.map((entry) => ({ name: entry.path, size: entry.size }))),
          }
        : null,
      expiresAt: link.expiresAt,
    };
  };

  const grant = (servable: ServableLink, visitor: string) => ({
    meta: sealMeta(servable.key, servable.link.id, metaOf(servable)),
    ticket: vault.signTicket<Ticket>({
      l: servable.link.id,
      v: visitor,
      g: shares.passwordGeneration(servable.link),
      exp: Date.now() + TICKET_TTL,
    }),
  });

  /**
   * The link, if the caller proved to hold its key and it can be served right now. Only someone holding
   * the key learns why a link is not available (paused, expired...); everyone else sees the same 404.
   */
  const authorize = (id: string, givenProof: string, visit: Visit) => {
    const link = shares.find(id);
    if (!link || !visit.visitor || !shares.holdsKey(link, givenProof)) return { ok: false as const };
    const found = shares.servable(id);
    if (!found.ok) {
      shares.record(id, { ...visit, type: 'refused', detail: found.reason });
      return { ok: false as const, reason: found.reason };
    }
    return { ok: true as const, servable: found.value, visitor: visit.visitor };
  };

  const validTicket = (id: string, visit: Visit, header: unknown): boolean => {
    const ticket = vault.readTicket<Ticket>(typeof header === 'string' ? header : undefined);
    const link = shares.find(id);
    if (!ticket || !link || ticket.l !== id || !visit.visitor || ticket.v !== visit.visitor) return false;
    return ticket.g === shares.passwordGeneration(link);
  };

  // The switch applies at once; the count of open links never looks at the disk, so any visitor may ask.
  app.get('/state', async () => {
    const service = settings.service();
    if (!service.enabled) return { online: false };
    if (!service.autoOff) return { online: true };
    if (Date.now() - activeLinks.at > ONLINE_CACHE || activeLinks.revision !== shares.revision) {
      activeLinks = { value: shares.openCount(), at: Date.now(), revision: shares.revision };
    }
    return { online: activeLinks.value > 0 };
  });

  app.post('/links/:id/preview', { schema: { params: linkParams } }, async (request, reply) => {
    const { id } = request.params;
    const now = Date.now();
    if (shares.find(id) && now - (lastPreview.get(id) ?? 0) > PREVIEW_INTERVAL) {
      lastPreview.set(id, now);
      shares.record(id, { ...visitOf(request.headers), type: 'preview' });
    }
    return reply.code(204).send();
  });

  app.post('/links/:id/open', { schema: { params: linkParams, body: z.object({ proof }) } }, async (request, reply) => {
    const visit = visitOf(request.headers);
    const allowed = authorize(request.params.id, request.body.proof, visit);
    if (!allowed.ok) return unavailable(reply, allowed.reason);
    shares.record(request.params.id, { ...visit, type: 'open' });
    if (allowed.servable.link.passwordHash) return { passwordRequired: true };
    return grant(allowed.servable, allowed.visitor);
  });

  app.post(
    '/links/:id/unlock',
    { schema: { params: linkParams, body: z.object({ proof, verifier: proof.optional() }) } },
    async (request, reply) => {
      const visit = visitOf(request.headers);
      const allowed = authorize(request.params.id, request.body.proof, visit);
      if (!allowed.ok) return unavailable(reply, allowed.reason);
      const { link } = allowed.servable;
      if (!link.passwordHash) return grant(allowed.servable, allowed.visitor);
      if (!request.body.verifier) return reply.code(403).send({ error: 'password_required' });
      // One scrypt per link at a time: bursts cannot outrun the lockout nor fill the thread pool used by downloads.
      if (checkingPassword.has(link.id)) return reply.code(429).send({ error: 'busy' });
      checkingPassword.add(link.id);
      let correct: boolean;
      try {
        correct = await verifySecret(link.passwordHash, request.body.verifier);
      } finally {
        checkingPassword.delete(link.id);
      }
      if (!correct) {
        const locked = shares.failPassword(link, visit);
        return reply.code(locked ? 404 : 403).send({ error: locked ? 'unavailable' : 'wrong_password' });
      }
      if (shares.find(link.id)?.lockedAt) return unavailable(reply);
      shares.unlocked(link, visit);
      return grant(allowed.servable, allowed.visitor);
    },
  );

  app.get(
    '/links/:id/files/:part',
    {
      schema: { params: linkParams.extend({ part: z.union([z.literal('all'), z.string().regex(/^[0-9a-f]{16}$/)]) }) },
    },
    async (request, reply) => {
      const { id, part } = request.params;
      const visit = visitOf(request.headers);
      const visitor = visit.visitor;
      if (!visitor || !validTicket(id, visit, request.headers[TICKET_HEADER])) {
        return reply.code(403).send({ error: 'ticket' });
      }

      const found = shares.servable(id);
      if (!found.ok) {
        shares.record(id, { ...visit, type: 'refused', detail: found.reason });
        // The ticket already proves the key: tell why, so retries are not counted as guesses.
        return unavailable(reply, found.reason);
      }
      const { entries } = found.value.content;
      const selected = part === 'all' ? entries : entries.filter((entry) => entry.id === part);
      const single = part === 'all' ? null : (selected[0] ?? null);
      const target = { file: single?.position ?? null, path: single?.path ?? null };
      if (selected.length === 0) {
        shares.record(id, { ...visit, ...target, type: 'refused', detail: 'file_unavailable' });
        return unavailable(reply, 'unavailable');
      }

      const total = [...perLink.values()].reduce((sum, n) => sum + n, 0);
      if (
        total >= MAX_DOWNLOADS ||
        (perLink.get(id) ?? 0) >= MAX_DOWNLOADS_PER_LINK ||
        (perVisitor.get(visitor) ?? 0) >= MAX_DOWNLOADS_PER_VISITOR
      ) {
        return reply.code(429).send({ error: 'busy' });
      }

      const abort = new AbortController();
      const opener = (entry: Entry) => () =>
        storage.open({ path: entry.source, size: entry.size, modifiedAt: entry.modifiedAt });
      let plainSize: number;
      let source: Readable;
      try {
        if (single) {
          plainSize = single.size;
          source = exactFile(opener(single)(), single.size, abort.signal);
        } else {
          const archive = selected.map((entry) => ({
            name: entry.path,
            size: entry.size,
            modifiedAt: entry.modifiedAt,
            open: opener(entry),
          }));
          plainSize = zipSize(archive);
          source = zipStream(archive, abort.signal);
        }
      } catch (error) {
        if (!(error instanceof StorageError)) throw error;
        shares.record(id, { ...visit, ...target, type: 'refused', detail: `file_${error.code}` });
        return unavailable(reply, 'unavailable');
      }

      const downloadId = randomId(9);
      let sent = 0;
      let settled = false;
      let sentAtLastCheck = -1;

      const settle = (type: 'download_finished' | 'download_aborted', detail?: string) => {
        if (settled) return;
        settled = true;
        clearInterval(watchdog);
        adjust(perLink, id, -1);
        adjust(perVisitor, visitor, -1);
        shares.record(id, { ...visit, ...target, type, downloadId, bytes: sent, detail });
      };

      // A client that stops reading would otherwise hold a download slot forever.
      const watchdog = setInterval(() => {
        if (sent === sentAtLastCheck) {
          abort.abort();
          reply.raw.destroy();
          settle('download_aborted', 'idle');
        }
        sentAtLastCheck = sent;
      }, IDLE_TIMEOUT);

      adjust(perLink, id, 1);
      adjust(perVisitor, visitor, 1);
      shares.record(id, { ...visit, ...target, type: 'download_started', downloadId, bytes: plainSize });
      source.on('data', (chunk: Buffer) => {
        sent += chunk.length;
      });
      const encrypted = pipeline(source, encryptStream(found.value.key, id, part), (error) => {
        if (error) settle('download_aborted', error.message);
      });
      encrypted.on('end', () => settle(sent === plainSize ? 'download_finished' : 'download_aborted'));
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) {
          abort.abort();
          settle('download_aborted', 'connection closed');
        }
      });

      return reply
        .header('content-type', 'application/octet-stream')
        .header('content-length', encryptedSize(plainSize))
        .header('cache-control', 'no-store')
        .header(DOWNLOAD_ID_HEADER, downloadId)
        .send(encrypted);
    },
  );

  app.post(
    '/links/:id/downloads/:downloadId/result',
    {
      schema: {
        params: linkParams.extend({ downloadId: z.string().regex(/^[\w-]{6,32}$/) }),
        body: z.object({ ok: z.boolean(), reason: z.string().max(64).optional() }),
      },
    },
    async (request, reply) => {
      const { id, downloadId } = request.params;
      const visit = visitOf(request.headers);
      if (!validTicket(id, visit, request.headers[TICKET_HEADER])) return reply.code(403).send({ error: 'ticket' });
      if (!shares.startedBy(id, downloadId, visit.visitor) || shares.hasResult(id, downloadId)) {
        return reply.code(404).send({ error: 'unknown_download' });
      }
      shares.record(id, {
        ...visit,
        type: request.body.ok ? 'download_verified' : 'download_failed',
        ...shares.downloadTarget(id, downloadId),
        downloadId,
        detail: request.body.reason,
      });
      return reply.code(204).send();
    },
  );

  return app;
}
