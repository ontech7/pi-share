/// <reference lib="webworker" />
import { decryptStream, plainSize, WireError } from '../shared/wire.ts';
import { DOWNLOAD_PREFIX, type DownloadJob, type FromWorker, type ToWorker } from './share/messages.ts';

declare const self: ServiceWorkerGlobalScope;

const jobs = new Map<string, { job: DownloadJob; clientId: string | null }>();

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const message = event.data as ToWorker;
  if (message.type !== 'prepare') return;
  const client = event.source as Client | null;
  jobs.set(message.job.token, { job: message.job, clientId: client?.id ?? null });
  client?.postMessage({ type: 'ready', token: message.job.token } satisfies FromWorker);
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(DOWNLOAD_PREFIX)) return;
  const token = url.pathname.slice(DOWNLOAD_PREFIX.length);
  const entry = jobs.get(token);
  jobs.delete(token);
  if (!entry) {
    event.respondWith(new Response(null, { status: 404 }));
    return;
  }
  const { response, finished } = startDownload(entry.job, entry.clientId);
  event.respondWith(response);
  event.waitUntil(finished);
});

function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function startDownload(job: DownloadJob, clientId: string | null) {
  let resolveFinished: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });

  const send = async (message: FromWorker) => {
    const client = clientId ? await self.clients.get(clientId) : null;
    client?.postMessage(message);
  };

  const report = (downloadId: string | null, ok: boolean, reason?: string) =>
    downloadId
      ? fetch(`/api/links/${job.linkId}/downloads/${downloadId}/result`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-ticket': job.ticket },
          body: JSON.stringify({ ok, reason }),
        }).catch(() => undefined)
      : Promise.resolve();

  const response = (async () => {
    const upstream = await fetch(job.url, { headers: { 'x-ticket': job.ticket }, cache: 'no-store' }).catch(() => null);
    if (!upstream?.ok || !upstream.body) {
      await send({
        type: 'error',
        token: job.token,
        reason: upstream?.status === 429 ? 'busy' : 'unavailable',
        status: upstream?.status,
      });
      resolveFinished();
      return new Response(null, { status: 204 });
    }

    const downloadId = upstream.headers.get('x-download-id');
    const total = plainSize(Number(upstream.headers.get('content-length')));
    let loaded = 0;
    let lastUpdate = 0;
    const decrypt = decryptStream(job.key, job.linkId, job.part, (bytes) => {
      loaded += bytes;
      const now = Date.now();
      if (now - lastUpdate > 120 || loaded === total) {
        lastUpdate = now;
        void send({ type: 'progress', token: job.token, loaded, total });
      }
    });

    const output = new TransformStream<Uint8Array, Uint8Array>();
    upstream.body
      .pipeThrough(decrypt)
      .pipeTo(output.writable)
      .then(
        async () => {
          await report(downloadId, true);
          await send({ type: 'done', token: job.token });
        },
        async (error: unknown) => {
          const reason = error instanceof WireError ? error.reason : 'network';
          await report(downloadId, false, reason);
          await send({ type: 'error', token: job.token, reason });
        },
      )
      .finally(resolveFinished);

    const headers = new Headers({
      'content-type': 'application/octet-stream',
      'content-disposition': contentDisposition(job.name),
      'x-content-type-options': 'nosniff',
    });
    if (Number.isFinite(total) && total >= 0) headers.set('content-length', String(total));
    return new Response(output.readable, { headers });
  })();

  return { response, finished };
}
