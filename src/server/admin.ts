import crypto from 'node:crypto';
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
  createTokenBody,
  installUpdateBody,
  loginBody,
  notificationsBody,
  notificationTestBody,
  type Preferences,
  preferencesBody,
  providersBody,
  type ServiceState,
  type SessionState,
  serviceBody,
  setupBody,
  updateLinkBody,
  updateSettingsBody,
} from '../shared/api.ts';
import { isOnline } from './broker.ts';
import type { Config } from './config.ts';
import { allowList, isAllowed } from './network.ts';
import type { Notifier } from './notify.ts';
import type { Providers } from './providers.ts';
import type { Settings } from './settings.ts';
import { ShareError, type Shares } from './shares.ts';
import { type Storage, StorageError } from './storage.ts';
import type { TokenOwner, Tokens } from './tokens.ts';
import type { Updates } from './updates.ts';

const SESSION_COOKIE = 'pi_share_session';
const CSRF_HEADER = 'x-pi-share';
const OPEN_ROUTES = new Set(['/api/session', '/api/setup', '/api/login']);
/** All an integration token may do: its own links, nothing about settings, updates or other tokens. */
const TOKEN_ROUTES = new Set(['GET /api/links', 'POST /api/links', 'GET /api/links/:id', 'DELETE /api/links/:id']);

export type AdminDeps = {
  config: Config;
  shares: Shares;
  settings: Settings;
  tokens: Tokens;
  storage: Storage;
  updates: Updates;
  providers: Providers;
  notifier: Notifier;
  setupCode: string | null;
  staticRoot?: string;
};

export function generateSetupCode(): string {
  const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

export async function buildAdmin({
  config,
  shares,
  settings,
  tokens,
  storage,
  updates,
  providers,
  notifier,
  setupCode,
  staticRoot,
}: AdminDeps) {
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: config.trustedProxies.length ? config.trustedProxies : false,
    bodyLimit: 64 * 1024,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const allowed = allowList(config.adminAllow);
  const owners = new WeakMap<FastifyRequest, TokenOwner>();
  const ownerOf = (request: FastifyRequest) => owners.get(request)?.id;
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
    // The container's own health probe comes from inside, by address: it answers nothing about links.
    if (request.routeOptions.url === '/healthz') return;
    if (config.adminHosts.length && !config.adminHosts.includes(host))
      return reply.code(421).send({ error: 'wrong_host' });

    // Decide on the route that matched, never on the raw URL: "/%61pi/links" routes to "/api/links".
    // Unmatched URLs only ever get the SPA shell or a 404, never data.
    const route = request.routeOptions.url;
    if (!route?.startsWith('/api/')) return;
    reply.header('cache-control', 'no-store');
    // A request carrying a token is the token's alone: the cookie is not looked at. No anti-CSRF header either,
    // since a browser cannot add an Authorization header to a cross-site request without CORS, which is off.
    // Other schemes (a proxy's Basic credentials) fall through to the cookie, which still needs the header.
    const authorization = request.headers.authorization ?? '';
    if (/^bearer\s/i.test(authorization)) {
      const owner = tokens.verify(/^bearer\s+(\S+)$/i.exec(authorization)?.[1] ?? '');
      if (!owner) return reply.code(401).send({ error: 'invalid_token' });
      if (!TOKEN_ROUTES.has(`${request.method} ${route}`)) return reply.code(403).send({ error: 'token_scope' });
      owners.set(request, owner);
      return;
    }
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

  const defaults: Preferences = {
    onChange: 'pause',
    expiryDays: config.defaultExpiryDays,
    maxDownloads: null,
    generatePassword: false,
  };

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

  app.get('/api/preferences', async () => settings.preferences(defaults));
  app.patch('/api/preferences', { schema: { body: preferencesBody } }, async (request) =>
    settings.updatePreferences(request.body, defaults),
  );

  app.get('/api/updates', async () => {
    updates.maybeCheck();
    return updates.info();
  });
  app.post('/api/updates/check', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async () => {
    await updates.check();
    return updates.info();
  });
  app.patch('/api/updates', { schema: { body: updateSettingsBody } }, async (request) => {
    updates.setAutoCheck(request.body.autoCheck);
    return updates.info();
  });
  app.post('/api/updates/install', { schema: { body: installUpdateBody } }, async (request, reply) => {
    updates.requestInstall(request.body.version);
    return reply.code(202).send(updates.info());
  });

  app.get('/api/providers', async () => providers.info());
  app.patch('/api/providers', { schema: { body: providersBody } }, async (request) => {
    providers.setEnabled(request.body.enabled);
    return providers.info();
  });
  app.post('/api/providers/refresh', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async () => {
    // Answers at once: the download takes a while on a Pi, the page polls the state.
    void providers.refresh().catch(() => undefined);
    return providers.info();
  });

  app.get('/api/notifications', async () => notifier.view());
  app.patch('/api/notifications', { schema: { body: notificationsBody } }, async (request) =>
    notifier.update(request.body),
  );
  app.post(
    '/api/notifications/test',
    { schema: { body: notificationTestBody }, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (request) => notifier.test(request.body.channel),
  );

  const tokenParams = z.object({ id: z.string().regex(/^[\w-]{12}$/) });

  app.get('/api/tokens', async () => tokens.list());
  app.post('/api/tokens', { schema: { body: createTokenBody } }, async (request, reply) =>
    reply.code(201).send(tokens.create(request.body)),
  );
  app.delete('/api/tokens/:id', { schema: { params: tokenParams } }, async (request, reply) => {
    tokens.remove(request.params.id);
    return reply.code(204).send();
  });

  const linkParams = z.object({ id: z.string().regex(/^[\w-]{10,64}$/) });

  app.get('/api/links', async (request) => shares.list(ownerOf(request)));
  // Every password costs a slow key derivation on a small board: a program stuck in a loop must not hog it.
  const tokenCreates = {
    max: 30,
    timeWindow: '1 minute',
    keyGenerator: (request: FastifyRequest) => ownerOf(request) ?? request.ip,
    allowList: (request: FastifyRequest) => !owners.has(request),
  };
  app.post(
    '/api/links',
    { schema: { body: createLinkBody }, config: { rateLimit: tokenCreates } },
    async (request, reply) =>
      reply.code(201).send(await shares.create(request.body, settings.preferences(defaults), owners.get(request))),
  );
  app.get('/api/links/:id', { schema: { params: linkParams } }, async (request) =>
    shares.detail(request.params.id, ownerOf(request)),
  );
  app.patch('/api/links/:id', { schema: { params: linkParams, body: updateLinkBody } }, async (request) =>
    shares.update(request.params.id, request.body),
  );
  app.delete('/api/links/:id', { schema: { params: linkParams } }, async (request, reply) => {
    shares.remove(request.params.id, ownerOf(request));
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
