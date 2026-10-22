import crypto from 'node:crypto';
import path from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { Agent, type Dispatcher, request as undiciRequest } from 'undici';
import { z } from 'zod';
import { DOWNLOAD_ID_HEADER, SECRET_HEADER, TICKET_HEADER, VISIT_HEADER } from './broker.ts';
import type { Config } from './config.ts';

const VISITOR_COOKIE = 'v';
const BOT_PATTERN =
  /bot|crawl|spider|preview|discord|slack|whatsapp|telegram|facebookexternalhit|skype|teams|embedly|curl|wget|python-requests|go-http-client/i;
const linkId = z.string().regex(/^[\w-]{10,64}$/);

export type EdgeDeps = {
  config: Pick<Config, 'brokerUrl' | 'clientIpHeader' | 'countryHeader' | 'publicUrl'>;
  brokerSecret: string | null;
  staticRoot: string;
  onlineCacheMs?: number;
};

type Visit = {
  ip: string;
  country: string | null;
  userAgent: string | null;
  language: string | null;
  visitor: string | null;
};

export function brokerDispatcher(address: string): { origin: string; dispatcher: Dispatcher } {
  if (address.startsWith('unix:')) {
    return { origin: 'http://broker', dispatcher: new Agent({ connect: { socketPath: address.slice(5) } }) };
  }
  return { origin: `http://${address}`, dispatcher: new Agent() };
}

/** Remembers addresses that keep asking for links that do not exist, and turns them away for a while. */
class Prober {
  private misses = new Map<string, { count: number; since: number }>();
  private blocked = new Map<string, number>();
  private readonly limit = 30;
  private readonly window = 10 * 60_000;
  private readonly penalty = 60 * 60_000;

  isBlocked(ip: string): boolean {
    const until = this.blocked.get(ip);
    if (!until) return false;
    if (until > Date.now()) return true;
    this.blocked.delete(ip);
    return false;
  }

  miss(ip: string) {
    const now = Date.now();
    const entry = this.misses.get(ip);
    const current = entry && now - entry.since < this.window ? entry : { count: 0, since: now };
    current.count++;
    this.misses.set(ip, current);
    if (current.count >= this.limit) {
      this.blocked.set(ip, now + this.penalty);
      this.misses.delete(ip);
    }
  }
}

export async function buildEdge({ config, brokerSecret, staticRoot, onlineCacheMs = 3000 }: EdgeDeps) {
  const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 4 * 1024, trustProxy: false });
  const broker = brokerDispatcher(config.brokerUrl);
  const prober = new Prober();
  const secureCookie = config.publicUrl.startsWith('https://');
  let online = { value: false, checkedAt: 0 };

  const visitOf = (request: FastifyRequest): Visit => {
    const forwarded = config.clientIpHeader ? request.headers[config.clientIpHeader] : undefined;
    const country = config.countryHeader ? request.headers[config.countryHeader] : undefined;
    return {
      ip: (typeof forwarded === 'string' && forwarded) || request.socket.remoteAddress || 'unknown',
      country: typeof country === 'string' ? country : null,
      userAgent: request.headers['user-agent'] ?? null,
      language: request.headers['accept-language'] ?? null,
      visitor: request.cookies[VISITOR_COOKIE] ?? null,
    };
  };

  const callBroker = async (
    method: 'GET' | 'POST',
    pathname: string,
    visit: Visit,
    options: { body?: unknown; ticket?: string; signal?: AbortSignal } = {},
  ) => {
    const headers: Record<string, string> = { [VISIT_HEADER]: JSON.stringify(visit) };
    if (brokerSecret) headers[SECRET_HEADER] = brokerSecret;
    if (options.ticket) headers[TICKET_HEADER] = options.ticket;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    return undiciRequest(`${broker.origin}${pathname}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      dispatcher: broker.dispatcher,
      signal: options.signal,
    });
  };

  const isOnline = async () => {
    if (Date.now() - online.checkedAt < onlineCacheMs) return online.value;
    try {
      const response = await callBroker('GET', '/state', {
        ip: '',
        country: null,
        userAgent: null,
        language: null,
        visitor: null,
      });
      const body = (await response.body.json()) as { online?: boolean };
      online = { value: response.statusCode === 200 && body.online === true, checkedAt: Date.now() };
    } catch {
      online = { value: false, checkedAt: Date.now() };
    }
    return online.value;
  };

  const relayJson = async (reply: FastifyReply, response: Dispatcher.ResponseData, visit: Visit) => {
    if (response.statusCode === 404) prober.miss(visit.ip);
    const text = await response.body.text();
    return reply
      .code(response.statusCode)
      .type('application/json')
      .send(text || '{}');
  };

  await app.register(fastifyCookie);
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        workerSrc: ["'self'"],
        frameSrc: ["'self'"],
        manifestSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'none'"],
        baseUri: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
  await app.register(fastifyRateLimit, {
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (request) => visitOf(request).ip,
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-robots-tag', 'noindex, nofollow, noarchive');
    if (!request.url.startsWith('/assets/')) reply.header('cache-control', 'no-store');
    if (prober.isBlocked(visitOf(request).ip) || !(await isOnline())) return reply.code(404).send();
  });

  await app.register(fastifyStatic, { root: path.resolve(staticRoot), index: false, wildcard: false, serve: false });

  app.get('/assets/*', async (request, reply) => {
    const file = (request.params as { '*': string })['*'];
    if (!/^[\w.-]+$/.test(file)) return reply.code(404).send();
    return reply.header('cache-control', 'public, max-age=31536000, immutable').sendFile(`assets/${file}`);
  });
  app.get('/sw.js', async (_request, reply) => reply.sendFile('sw.js'));
  app.get('/favicon.svg', async (_request, reply) => reply.sendFile('favicon.svg'));

  app.get('/d/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!linkId.safeParse(id).success) return reply.code(404).send();
    const visit = visitOf(request);
    if (!visit.visitor) {
      visit.visitor = crypto.randomBytes(16).toString('base64url');
      reply.setCookie(VISITOR_COOKIE, visit.visitor, {
        httpOnly: true,
        sameSite: 'lax',
        secure: secureCookie,
        path: '/',
        maxAge: 365 * 24 * 60 * 60,
      });
    }
    if (BOT_PATTERN.test(visit.userAgent ?? '')) {
      await callBroker('POST', `/links/${id}/preview`, visit).then(
        (r) => r.body.dump(),
        () => undefined,
      );
    }
    return reply.type('text/html').sendFile('index.html');
  });

  app.post('/api/links/:id/open', async (request, reply) => {
    const { id } = request.params as { id: string };
    const visit = visitOf(request);
    if (!linkId.safeParse(id).success) return reply.code(404).send();
    return relayJson(reply, await callBroker('POST', `/links/${id}/open`, visit), visit);
  });

  app.post(
    '/api/links/:id/unlock',
    { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const visit = visitOf(request);
      if (!linkId.safeParse(id).success) return reply.code(404).send();
      return relayJson(reply, await callBroker('POST', `/links/${id}/unlock`, visit, { body: request.body }), visit);
    },
  );

  app.get('/api/links/:id/files/:part', async (request, reply) => {
    const { id, part } = request.params as { id: string; part: string };
    if (!linkId.safeParse(id).success || !/^(all|\d{1,4})$/.test(part)) return reply.code(404).send();
    const visit = visitOf(request);
    const abort = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) abort.abort();
    });
    const response = await callBroker('GET', `/links/${id}/files/${part}`, visit, {
      ticket: request.headers[TICKET_HEADER] as string | undefined,
      signal: abort.signal,
    });
    if (response.statusCode !== 200) return relayJson(reply, response, visit);
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', response.headers['content-length'])
      .header(DOWNLOAD_ID_HEADER, response.headers[DOWNLOAD_ID_HEADER])
      .send(response.body);
  });

  app.post('/api/links/:id/downloads/:downloadId/result', async (request, reply) => {
    const { id, downloadId } = request.params as { id: string; downloadId: string };
    if (!linkId.safeParse(id).success || !/^[\w-]{6,32}$/.test(downloadId)) return reply.code(404).send();
    const visit = visitOf(request);
    const response = await callBroker('POST', `/links/${id}/downloads/${downloadId}/result`, visit, {
      body: request.body,
      ticket: request.headers[TICKET_HEADER] as string | undefined,
    });
    return relayJson(reply, response, visit);
  });

  app.setNotFoundHandler((_request, reply) => reply.code(404).send());
  app.setErrorHandler((error, _request, reply) => {
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 429) return reply.code(429).send({ error: 'too_many_requests' });
    if (status && status < 500) return reply.code(status).send();
    app.log.error(error);
    return reply.code(502).send();
  });

  return app;
}
