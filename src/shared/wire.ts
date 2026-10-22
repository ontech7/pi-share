// Browser side of the encryption format (see README → "How the encryption works").
// Runs in the share page, in the service worker and in the tests, so it only uses WebCrypto and web streams.

export const MAGIC = new Uint8Array([0x50, 0x53, 0x48, 0x31]); // "PSH1"
export const HEADER_SIZE = 24;
export const TAG_SIZE = 16;
export const RECORD_SIZE = 64 * 1024;
export const PBKDF2_ITERATIONS = 600_000;

export type Sealed = { iv: string; ct: string };
/** 'all' for the whole share as one archive, otherwise the id of one entry. */
export type FilePart = string;

const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export const metaInfo = 'pi-share/v1/meta';
export const fileInfo = (linkId: string, part: FilePart) => `pi-share/v1/file/${linkId}/${part}`;
export const passwordSalt = (linkId: string) => `pi-share/v1/pw/${linkId}`;
export const passwordInfo = 'pi-share/v1/password';
export const proofInfo = 'pi-share/v1/proof';

export function recordNonce(counter: number, last: boolean): Uint8Array<ArrayBuffer> {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(3, BigInt(counter));
  nonce[11] = last ? 1 : 0;
  return nonce;
}

async function deriveKey(linkKey: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, info: string) {
  const base = await crypto.subtle.importKey('raw', linkKey, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(info) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
}

export async function openMeta<T>(linkKey: Uint8Array<ArrayBuffer>, linkId: string, sealed: Sealed): Promise<T> {
  const key = await deriveKey(linkKey, new Uint8Array(0), metaInfo);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(sealed.iv), additionalData: encoder.encode(linkId) },
    key,
    fromBase64Url(sealed.ct),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

async function hmacWithLinkKey(linkKey: Uint8Array<ArrayBuffer>, info: string, message: Uint8Array<ArrayBuffer>) {
  const base = await crypto.subtle.importKey('raw', linkKey, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(info) },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
  return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, message)));
}

/** Proves the caller holds the link key, so knowing the link id alone opens nothing and locks nothing. */
export function keyProof(linkKey: Uint8Array<ArrayBuffer>, linkId: string): Promise<string> {
  return hmacWithLinkKey(linkKey, proofInfo, encoder.encode(linkId));
}

/**
 * Sent instead of the password. Keyed with the link key, so whoever sees it in transit
 * can neither guess the password offline nor use it on another link.
 */
export async function passwordVerifier(
  password: string,
  linkKey: Uint8Array<ArrayBuffer>,
  linkId: string,
): Promise<string> {
  const base = await crypto.subtle.importKey('raw', encoder.encode(password.normalize('NFC')), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(passwordSalt(linkId)), iterations: PBKDF2_ITERATIONS },
    base,
    256,
  );
  return hmacWithLinkKey(linkKey, passwordInfo, new Uint8Array(bits));
}

export type WireFailure = 'format' | 'integrity' | 'truncated';

/** Plaintext size from the ciphertext length: header plus a 16-byte tag per record. */
export function plainSize(encrypted: number, recordSize = RECORD_SIZE): number {
  const records = Math.max(1, Math.ceil((encrypted - HEADER_SIZE) / (recordSize + TAG_SIZE)));
  return encrypted - HEADER_SIZE - records * TAG_SIZE;
}

export class WireError extends Error {
  readonly reason: WireFailure;

  constructor(reason: WireFailure) {
    super(reason);
    this.reason = reason;
  }
}

class ByteQueue {
  private parts: Uint8Array[] = [];
  length = 0;

  push(chunk: Uint8Array) {
    if (chunk.length === 0) return;
    this.parts.push(chunk);
    this.length += chunk.length;
  }

  take(n: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(n);
    let offset = 0;
    while (offset < n) {
      const part = this.parts[0] as Uint8Array;
      const count = Math.min(part.length, n - offset);
      out.set(part.subarray(0, count), offset);
      offset += count;
      if (count === part.length) this.parts.shift();
      else this.parts[0] = part.subarray(count);
    }
    this.length -= n;
    return out;
  }
}

/** The Web Crypto key type, the same with the DOM types and with Node's. */
type AesKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/** Ciphertext in, verified plaintext out. Throws WireError on any tampering or truncation. */
export function decryptStream(
  linkKey: Uint8Array<ArrayBuffer>,
  linkId: string,
  part: FilePart,
  onProgress?: (plainBytes: number) => void,
): TransformStream<Uint8Array, Uint8Array> {
  const queue = new ByteQueue();
  let key: AesKey | null = null;
  let recordSize = 0;
  let counter = 0;

  const open = async (record: Uint8Array<ArrayBuffer>, last: boolean) => {
    try {
      const plain = new Uint8Array(
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv: recordNonce(counter++, last) }, key as AesKey, record),
      );
      onProgress?.(plain.length);
      return plain;
    } catch {
      throw new WireError('integrity');
    }
  };

  return new TransformStream({
    async transform(chunk, controller) {
      queue.push(chunk);
      if (!key) {
        if (queue.length < HEADER_SIZE) return;
        const header = queue.take(HEADER_SIZE);
        if (MAGIC.some((byte, i) => header[i] !== byte)) throw new WireError('format');
        recordSize = new DataView(header.buffer).getUint32(20);
        if (recordSize < 1024 || recordSize > 16 * 1024 * 1024) throw new WireError('format');
        key = await deriveKey(linkKey, header.slice(4, 20), fileInfo(linkId, part));
      }
      // A full record followed by more bytes cannot be the last one.
      while (queue.length > recordSize + TAG_SIZE) {
        controller.enqueue(await open(queue.take(recordSize + TAG_SIZE), false));
      }
    },
    async flush(controller) {
      if (!key || queue.length < TAG_SIZE) throw new WireError('truncated');
      const plain = await open(queue.take(queue.length), true);
      if (plain.length > 0) controller.enqueue(plain);
    },
  });
}
