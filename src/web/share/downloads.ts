import { useCallback, useEffect, useRef, useState } from 'react';
import { decryptStream, type FilePart, plainSize, WireError } from '../../shared/wire.ts';
import type { LinkRef } from './link.ts';
import { DOWNLOAD_PREFIX, type FromWorker } from './messages.ts';

export type DownloadState =
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'running'; loaded: number; total: number }
  | { status: 'done' }
  | { status: 'error'; reason: string };

type Target = { part: FilePart; name: string; size: number };

const MEMORY_LIMIT = 1.5 * 1024 ** 3;

function isFresh(ticket: string | null): ticket is string {
  if (!ticket) return false;
  try {
    const { exp } = JSON.parse(atob((ticket.split('.')[0] ?? '').replace(/-/g, '+').replace(/_/g, '/'))) as {
      exp: number;
    };
    return exp - Date.now() > 5 * 60_000;
  } catch {
    return false;
  }
}

async function workerReady(): Promise<ServiceWorker | null> {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 3000);
      navigator.serviceWorker.addEventListener(
        'controllerchange',
        () => {
          clearTimeout(timer);
          resolve(navigator.serviceWorker.controller);
        },
        { once: true },
      );
    });
  } catch {
    return null;
  }
}

export function useDownloads(link: LinkRef, ticket: string | null, refreshTicket: () => Promise<string | null>) {
  const [states, setStates] = useState<Record<string, DownloadState>>({});
  const [worker, setWorker] = useState<ServiceWorker | null | undefined>(undefined);
  const tokens = useRef(new Map<string, string>());

  const set = useCallback(
    (key: string, state: DownloadState) => setStates((current) => ({ ...current, [key]: state })),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    workerReady().then((ready) => {
      if (!cancelled) setWorker(ready);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent<FromWorker>) => {
      const key = tokens.current.get(event.data.token);
      if (!key) return;
      const message = event.data;
      if (message.type === 'progress') set(key, { status: 'running', loaded: message.loaded, total: message.total });
      if (message.type === 'done') set(key, { status: 'done' });
      if (message.type === 'error') set(key, { status: 'error', reason: message.reason });
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [set]);

  const active = Object.values(states).some((state) => state.status === 'running' || state.status === 'starting');

  useEffect(() => {
    if (!active || !worker) return;
    const timer = setInterval(() => worker.postMessage({ type: 'ping' }), 10_000);
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => {
      clearInterval(timer);
      window.removeEventListener('beforeunload', warn);
    };
  }, [active, worker]);

  const viaWorker = useCallback(
    (key: string, target: Target, currentTicket: string) => {
      const sw = worker as ServiceWorker;
      const token = crypto.randomUUID();
      tokens.current.set(token, key);
      const onReady = (event: MessageEvent<FromWorker>) => {
        if (event.data.type !== 'ready' || event.data.token !== token) return;
        navigator.serviceWorker.removeEventListener('message', onReady);
        const frame = document.createElement('iframe');
        frame.hidden = true;
        frame.src = `${DOWNLOAD_PREFIX}${token}`;
        document.body.append(frame);
        setTimeout(() => frame.remove(), 60_000);
      };
      navigator.serviceWorker.addEventListener('message', onReady);
      sw.postMessage({
        type: 'prepare',
        job: {
          token,
          url: `/api/links/${link.id}/files/${target.part}`,
          ticket: currentTicket,
          linkId: link.id,
          part: target.part,
          key: link.key,
          name: target.name,
        },
      });
    },
    [worker, link],
  );

  const inMemory = useCallback(
    async (key: string, target: Target, currentTicket: string) => {
      const response = await fetch(`/api/links/${link.id}/files/${target.part}`, {
        headers: { 'x-ticket': currentTicket },
        cache: 'no-store',
      });
      if (!response.ok || !response.body) {
        set(key, { status: 'error', reason: response.status === 429 ? 'busy' : 'unavailable' });
        return;
      }
      const downloadId = response.headers.get('x-download-id');
      const total = plainSize(Number(response.headers.get('content-length')));
      let loaded = 0;
      const report = (ok: boolean, reason?: string) =>
        fetch(`/api/links/${link.id}/downloads/${downloadId}/result`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-ticket': currentTicket },
          body: JSON.stringify({ ok, reason }),
        }).catch(() => undefined);
      try {
        const plain = response.body.pipeThrough(
          decryptStream(link.key, link.id, target.part, (bytes) => {
            loaded += bytes;
            set(key, { status: 'running', loaded, total });
          }),
        );
        const blob = await new Response(plain).blob();
        const url = URL.createObjectURL(blob);
        const anchor = Object.assign(document.createElement('a'), { href: url, download: target.name });
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        await report(true);
        set(key, { status: 'done' });
      } catch (error) {
        const reason = error instanceof WireError ? error.reason : 'network';
        await report(false, reason);
        set(key, { status: 'error', reason });
      }
    },
    [link, set],
  );

  const start = useCallback(
    async (target: Target) => {
      const key = String(target.part);
      set(key, { status: 'starting' });
      const currentTicket = isFresh(ticket) ? ticket : await refreshTicket();
      if (!currentTicket) {
        set(key, { status: 'error', reason: 'unavailable' });
        return;
      }
      if (worker) viaWorker(key, target, currentTicket);
      else await inMemory(key, target, currentTicket);
    },
    [ticket, refreshTicket, worker, viaWorker, inMemory, set],
  );

  return {
    states,
    start,
    ready: worker !== undefined,
    inMemoryOnly: worker === null,
    tooLargeForMemory: (size: number) => worker === null && size > MEMORY_LIMIT,
  };
}
