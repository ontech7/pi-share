import crypto from 'node:crypto';
import fs from 'node:fs';
import { pipeline, type Readable } from 'node:stream';
import Fastify, { type FastifyReply } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ShareMeta } from '../shared/api.ts';
import type { FilePart } from '../shared/wire.ts';
import { encryptedSize, encryptStream, randomId, sealMeta, type Vault, verifySecret } from './crypto.ts';
import type { Settings } from './settings.ts';
import type { ServableLink, Shares, Visit } from './shares.ts';
import type { Storage } from './storage.ts';
import { archiveNames, zipSize, zipStream } from './zip.ts';

/** The edge passes what it knows about the visitor in this header, as JSON. */
export const VISIT_HEADER = 'x-visit';
export const TICKET_HEADER = 'x-ticket';
export const SECRET_HEADER = 'x-broker-secret';
export const DOWNLOAD_ID_HEADER = 'x-download-id';

const TICKET_TTL = 6 * 60 * 60 * 1000;
const MAX_DOWNLOADS_PER_LINK = 4;
const MAX_DOWNLOADS = 16;

const visitSchema = z.object({
  ip: z.string().max(64).nullable().optional(),
  country: z.string().max(8).nullable().optional(),
  userAgent: z.string().max(1024).nullable().optional(),
  language: z.string().max(256).nullable().optional(),
  visitor: z.string().max(64).nullable().optional(),
});

type Ticket = { l: string; v: string | null; exp: number };

const linkParams = z.object({ id: z.string().regex(/^[\w-]{10,64}$/) });

export type BrokerDeps = {
  shares: Shares;
  settings: Settings;
  storage: Storage;
  vault: Vault;
  secret: string | null;
};

export function isOnline(shares: Shares, settings: Settings): boolean {
  const service = settings.service();
  return service.enabled && (!service.autoOff || shares.activeCount() > 0);
}

export function buildBroker({ shares, settings, storage, vault, secret }: BrokerDeps) {
  const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 16 * 1024 }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const running = new Map<string, number>();

  app.addHook('onRequest', async (request, reply) => {
    if (!secret) return;
    const given = Buffer.from(String(request.headers[SECRET_HEADER] ?? ''));
    const expected = Buffer.from(secret);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return reply.code(401).send();
  });

  const visitOf = (headers: Record<string, unknown>): Visit => {
    try {
      return visitSchema.parse(JSON.parse(String(headers[VISIT_HEADER] ?? '{}')));
    } catch {
      return {};
    }
  };

  const unavailable = (reply: FastifyReply) => reply.code(404).send({ error: 'unavailable' });

  const metaOf = ({ link, files }: ServableLink): ShareMeta => {
    const available = files.filter((file) => file.state === 'ok');
    const names = archiveNames(available.map((file) => file.name));
    return {
      files: files.map((file) => ({ name: file.name, size: file.size, available: file.state === 'ok' })),
      bundle:
        available.length > 1
          ? {
              name: `${(link.label || 'files').replace(/[\\/:*?"<>|]+/g, '_')}.zip`,
              size: zipSize(available.map((file, i) => ({ name: names[i] as string, size: file.size }))),
            }
          : null,
      expiresAt: link.expiresAt,
    };
  };

  const grant = (servable: ServableLink, visit: Visit) => ({
    meta: sealMeta(servable.key, servable.link.id, metaOf(servable)),
    ticket: vault.signTicket<Ticket>({ l: servable.link.id, v: visit.visitor ?? null, exp: Date.now() + TICKET_TTL }),
  });

  app.get('/state', async () => ({ online: isOnline(shares, settings) }));

  app.post('/links/:id/preview', { schema: { params: linkParams } }, async (request, reply) => {
    const found = shares.servable(request.params.id);
    if (found.ok || found.reason !== 'not_found') {
      shares.record(request.params.id, { ...visitOf(request.headers), type: 'preview' });
    }
    return reply.code(204).send();
  });

  app.post('/links/:id/open', { schema: { params: linkParams } }, async (request, reply) => {
    const visit = visitOf(request.headers);
    const found = shares.servable(request.params.id);
    if (!found.ok) {
      if (found.reason !== 'not_found')
        shares.record(request.params.id, { ...visit, type: 'refused', detail: found.reason });
      return unavailable(reply);
    }
    shares.record(request.params.id, { ...visit, type: 'open' });
    if (found.value.link.passwordHash) return { passwordRequired: true };
    return grant(found.value, visit);
  });

  app.post(
    '/links/:id/unlock',
    { schema: { params: linkParams, body: z.object({ verifier: z.string().regex(/^[\w-]{43}$/) }) } },
    async (request, reply) => {
      const visit = visitOf(request.headers);
      const found = shares.servable(request.params.id);
      if (!found.ok) {
        if (found.reason !== 'not_found')
          shares.record(request.params.id, { ...visit, type: 'refused', detail: found.reason });
        return unavailable(reply);
      }
      const { link } = found.value;
      if (!link.passwordHash) return grant(found.value, visit);
      if (!verifySecret(link.passwordHash, request.body.verifier)) {
        const locked = shares.failPassword(link, visit);
        return reply.code(locked ? 404 : 403).send({ error: locked ? 'unavailable' : 'wrong_password' });
      }
      shares.record(link.id, { ...visit, type: 'unlocked' });
      return grant(found.value, visit);
    },
  );

  app.get(
    '/links/:id/files/:part',
    { schema: { params: linkParams.extend({ part: z.union([z.literal('all'), z.coerce.number().int().min(0)]) }) } },
    async (request, reply) => {
      const { id, part } = request.params;
      const visit = visitOf(request.headers);
      const ticket = vault.readTicket<Ticket>(request.headers[TICKET_HEADER] as string | undefined);
      if (!ticket || ticket.l !== id || ticket.v !== (visit.visitor ?? null))
        return reply.code(403).send({ error: 'ticket' });

      const found = shares.servable(id);
      if (!found.ok) {
        if (found.reason !== 'not_found') shares.record(id, { ...visit, type: 'refused', detail: found.reason });
        return unavailable(reply);
      }
      const available = found.value.files.filter((file) => file.state === 'ok');
      const selected = part === 'all' ? available : available.filter((file) => file.position === part);
      if (selected.length === 0 || (part === 'all' && selected.length < 2)) {
        shares.record(id, {
          ...visit,
          type: 'refused',
          file: part === 'all' ? null : part,
          detail: 'file_unavailable',
        });
        return unavailable(reply);
      }

      const busy = running.get(id) ?? 0;
      const total = [...running.values()].reduce((sum, n) => sum + n, 0);
      if (busy >= MAX_DOWNLOADS_PER_LINK || total >= MAX_DOWNLOADS) return reply.code(429).send({ error: 'busy' });

      const absolute = selected.map((file) => ({ ...file, absolute: storage.file(file.path).absolute }));
      const names = archiveNames(absolute.map((file) => file.name));
      const plainSize =
        part === 'all'
          ? zipSize(absolute.map((file, i) => ({ name: names[i] as string, size: file.size })))
          : (absolute[0]?.size ?? 0);

      const abort = new AbortController();
      const source: Readable =
        part === 'all'
          ? zipStream(
              absolute.map((file, i) => ({ ...file, name: names[i] as string })),
              abort.signal,
            )
          : fs.createReadStream((absolute[0] as { absolute: string }).absolute, { signal: abort.signal });

      const downloadId = randomId(9);
      const file = part === 'all' ? null : part;
      let sent = 0;
      let settled = false;
      const settle = (type: 'download_finished' | 'download_aborted', detail?: string) => {
        if (settled) return;
        settled = true;
        running.set(id, (running.get(id) ?? 1) - 1);
        shares.record(id, { ...visit, type, file, downloadId, bytes: sent, detail });
      };

      running.set(id, busy + 1);
      shares.record(id, { ...visit, type: 'download_started', file, downloadId, bytes: plainSize });
      source.on('data', (chunk: Buffer) => {
        sent += chunk.length;
      });
      const encrypted = pipeline(source, encryptStream(found.value.key, id, part as FilePart), (error) => {
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
      const ticket = vault.readTicket<Ticket>(request.headers[TICKET_HEADER] as string | undefined);
      if (!ticket || ticket.l !== id) return reply.code(403).send({ error: 'ticket' });
      if (!shares.hasDownload(id, downloadId)) return reply.code(404).send({ error: 'unknown_download' });
      shares.record(id, {
        ...visit,
        type: request.body.ok ? 'download_verified' : 'download_failed',
        file: shares.downloadFile(id, downloadId),
        downloadId,
        detail: request.body.reason,
      });
      return reply.code(204).send();
    },
  );

  return app;
}
