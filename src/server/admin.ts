import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  changePasswordBody,
  createLinkBody,
  loginBody,
  type ServiceState,
  type SessionState,
  serviceBody,
  setupBody,
  updateLinkBody,
} from '../shared/api.ts';
import { isOnline } from './broker.ts';
import type { Config } from './config.ts';
import type { Settings } from './settings.ts';
import { ShareError, type Shares } from './shares.ts';
import { type Storage, StorageError } from './storage.ts';

const SESSION_COOKIE = 'pi_share_session';
const CSRF_HEADER = 'x-pi-share';
const OPEN_ROUTES = new Set(['/api/session', '/api/setup', '/api/login']);

export type AdminDeps = {
  config: Config;
  shares: Shares;
  settings: Settings;
  storage: Storage;
  setupCode: string | null;
  staticRoot?: string;
};

export function allowList(cidrs: string[]): net.BlockList {
  const list = new net.BlockList();
  for (const cidr of cidrs) {
    const [address = '', prefix] = cidr.split('/');
    const type = net.isIPv6(address) ? 'ipv6' : 'ipv4';
    list.addSubnet(address, Number(prefix ?? (type === 'ipv6' ? 128 : 32)), type);
  }
  return list;
}

export function isAllowed(list: net.BlockList, ip: string): boolean {
  const plain = ip.replace(/^::ffff:/, '');
  return list.check(plain, net.isIPv6(plain) ? 'ipv6' : 'ipv4');
}

export function generateSetupCode(): string {
  const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

export async function buildAdmin({ config, shares, settings, storage, setupCode, staticRoot }: AdminDeps) {
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: config.trustedProxies.length ? config.trustedProxies : false,
    bodyLimit: 64 * 1024,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const allowed = allowList(config.adminAllow);
  let pendingSetupCode = settings.hasAdminPassword() ? null : setupCode;

  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: false });
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'none'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
    hsts: false,
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!isAllowed(allowed, request.ip)) return reply.code(403).send({ error: 'forbidden_network' });
    const host = (request.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    if (config.adminHosts.length && !config.adminHosts.includes(host))
      return reply.code(421).send({ error: 'wrong_host' });

    // Decide on the route that matched, never on the raw URL: "/%61pi/links" routes to "/api/links".
    // Unmatched URLs only ever get the SPA shell or a 404, never data.
    const route = request.routeOptions.url;
    if (!route?.startsWith('/api/')) return;
    reply.header('cache-control', 'no-store');
    if (request.method !== 'GET' && request.headers[CSRF_HEADER] !== '1')
      return reply.code(403).send({ error: 'csrf' });
    if (!OPEN_ROUTES.has(route) && !settings.isValidSession(request.cookies[SESSION_COOKIE])) {
      return reply.code(401).send({ error: 'unauthenticated' });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error))
      return reply.code(400).send({ error: 'invalid', issues: error.validation });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid', issues: error.issues });
    if (error instanceof ShareError) return reply.code(error.status).send({ error: error.code, ...error.data });
    if (error instanceof StorageError) {
      const status = error.code === 'not_found' ? 404 : error.code === 'unreadable' ? 403 : 400;
      return reply.code(status).send({ error: error.code });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (error as Error).message });
    app.log.error(error);
    return reply.code(500).send({ error: 'internal' });
  });

  const startSession = (request: FastifyRequest, reply: FastifyReply) => {
    const session = settings.createSession();
    reply.setCookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: request.protocol === 'https',
      path: '/',
      expires: new Date(session.expiresAt),
    });
  };

  const serviceState = (): ServiceState => ({
    ...settings.service(),
    online: isOnline(shares, settings),
    activeLinks: shares.activeCount(),
    publicUrl: config.publicUrl,
  });

  app.get('/healthz', async () => ({ ok: true }));

  app.get(
    '/api/session',
    async (request): Promise<SessionState> => ({
      authenticated: settings.isValidSession(request.cookies[SESSION_COOKIE]),
      needsSetup: !settings.hasAdminPassword(),
      lang: config.lang,
    }),
  );

  app.post(
    '/api/setup',
    { schema: { body: setupBody }, config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      if (settings.hasAdminPassword() || !pendingSetupCode) return reply.code(409).send({ error: 'already_set_up' });
      const given = Buffer.from(request.body.code.trim().toUpperCase());
      const expected = Buffer.from(pendingSetupCode);
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
        return reply.code(403).send({ error: 'wrong_code' });
      }
      pendingSetupCode = null;
      await settings.setAdminPassword(request.body.password);
      startSession(request, reply);
      return { ok: true };
    },
  );

  app.post(
    '/api/login',
    { schema: { body: loginBody }, config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      if (!(await settings.checkAdminPassword(request.body.password)))
        return reply.code(403).send({ error: 'wrong_password' });
      startSession(request, reply);
      return { ok: true };
    },
  );

  app.post('/api/logout', async (request, reply) => {
    settings.endSession(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/password', { schema: { body: changePasswordBody } }, async (request, reply) => {
    if (!(await settings.checkAdminPassword(request.body.current)))
      return reply.code(403).send({ error: 'wrong_password' });
    await settings.setAdminPassword(request.body.password);
    startSession(request, reply);
    return { ok: true };
  });

  app.get('/api/service', async () => serviceState());

  app.patch('/api/service', { schema: { body: serviceBody } }, async (request) => {
    settings.updateService(request.body);
    return serviceState();
  });

  app.get(
    '/api/browse',
    { schema: { querystring: z.object({ path: z.string().max(4096).default('') }) } },
    async (request) => storage.browse(request.query.path),
  );

  const linkParams = z.object({ id: z.string().regex(/^[\w-]{10,64}$/) });

  app.get('/api/links', async () => shares.list());
  app.post('/api/links', { schema: { body: createLinkBody } }, async (request, reply) =>
    reply.code(201).send(await shares.create(request.body)),
  );
  app.get('/api/links/:id', { schema: { params: linkParams } }, async (request) => shares.detail(request.params.id));
  app.patch('/api/links/:id', { schema: { params: linkParams, body: updateLinkBody } }, async (request) =>
    shares.update(request.params.id, request.body),
  );
  app.delete('/api/links/:id', { schema: { params: linkParams } }, async (request, reply) => {
    shares.remove(request.params.id);
    return reply.code(204).send();
  });

  if (staticRoot) {
    await app.register(fastifyStatic, { root: path.resolve(staticRoot), wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not_found' });
    });
  }

  return app;
}
