import type { RefusalReason, ShareMeta } from '../../shared/api.ts';
import { fromBase64Url, keyProof, openMeta, passwordVerifier, type Sealed } from '../../shared/wire.ts';

export type LinkRef = { id: string; key: Uint8Array<ArrayBuffer> };
export type Grant = { meta: ShareMeta; ticket: string };

export type OpenResult =
  | { kind: 'granted'; grant: Grant }
  | { kind: 'password' }
  | { kind: 'unavailable'; reason?: RefusalReason }
  | { kind: 'busy' };

export type UnlockResult = OpenResult | { kind: 'wrong' };

/**
 * Reads the key from the fragment, then removes it from the address bar so it does not end up in the
 * history or in synced tabs. A reload therefore needs the link again, on purpose.
 */
export function readLink(location: Location): LinkRef | 'no-key' | null {
  const id = /^\/d\/([\w-]{10,64})\/?$/.exec(location.pathname)?.[1];
  if (!id) return null;
  try {
    const key = fromBase64Url(location.hash.slice(1));
    if (key.length !== 32) return 'no-key';
    history.replaceState(null, '', location.pathname);
    return { id, key };
  } catch {
    return 'no-key';
  }
}

async function post(path: string, body?: unknown) {
  return fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function toGrant(link: LinkRef, response: Response): Promise<OpenResult> {
  if (response.status === 429) return { kind: 'busy' };
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { reason?: RefusalReason };
    return { kind: 'unavailable', reason: data.reason };
  }
  const data = (await response.json()) as { passwordRequired?: boolean; meta?: Sealed; ticket?: string };
  if (data.passwordRequired) return { kind: 'password' };
  if (!data.meta || !data.ticket) return { kind: 'unavailable' };
  const meta = await openMeta<ShareMeta>(link.key, link.id, data.meta);
  return { kind: 'granted', grant: { meta, ticket: data.ticket } };
}

export async function openLink(link: LinkRef): Promise<OpenResult> {
  return toGrant(link, await post(`/api/links/${link.id}/open`, { proof: await keyProof(link.key, link.id) }));
}

/** Without a verifier this only renews the ticket of a link that has no password. */
export async function unlockLink(link: LinkRef, verifier?: string): Promise<UnlockResult> {
  const response = await post(`/api/links/${link.id}/unlock`, { proof: await keyProof(link.key, link.id), verifier });
  if (response.status === 403) return { kind: 'wrong' };
  return toGrant(link, response);
}

export const verifierFor = (link: LinkRef, password: string) => passwordVerifier(password, link.key, link.id);
