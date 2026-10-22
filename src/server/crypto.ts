import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import {
  type FilePart,
  fileInfo,
  HEADER_SIZE,
  MAGIC,
  metaInfo,
  PBKDF2_ITERATIONS,
  passwordSalt,
  RECORD_SIZE,
  recordNonce,
  type Sealed,
  TAG_SIZE,
} from '../shared/wire.ts';

export const randomId = (bytes = 16) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

const hkdf = (key: Buffer, salt: Buffer, info: string) =>
  Buffer.from(crypto.hkdfSync('sha256', key, salt, Buffer.from(info), 32));

export function sealMeta(linkKey: Buffer, linkId: string, value: unknown): Sealed {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', hkdf(linkKey, Buffer.alloc(0), metaInfo), iv);
  cipher.setAAD(Buffer.from(linkId));
  const ct = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]);
  return { iv: iv.toString('base64url'), ct: ct.toString('base64url') };
}

/** Plaintext in, wire format out. Holds one record back so the last one can be flagged as such. */
export function encryptStream(linkKey: Buffer, linkId: string, part: FilePart, recordSize = RECORD_SIZE): Transform {
  const salt = crypto.randomBytes(16);
  const key = hkdf(linkKey, salt, fileInfo(linkId, part));
  const header = Buffer.alloc(HEADER_SIZE);
  header.set(MAGIC, 0);
  salt.copy(header, 4);
  header.writeUInt32BE(recordSize, 20);

  let counter = 0;
  let pending: Buffer = Buffer.alloc(0);
  let headerSent = false;

  const seal = (plain: Buffer, last: boolean) => {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, recordNonce(counter++, last));
    return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  };

  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (!headerSent) {
        this.push(header);
        headerSent = true;
      }
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      const records: Buffer[] = [];
      let offset = 0;
      while (pending.length - offset > recordSize) {
        records.push(seal(pending.subarray(offset, offset + recordSize), false));
        offset += recordSize;
      }
      pending = pending.subarray(offset);
      if (records.length) this.push(Buffer.concat(records));
      done();
    },
    flush(done) {
      if (!headerSent) this.push(header);
      this.push(seal(pending, true));
      done();
    },
  });
}

export function encryptedSize(plainSize: number, recordSize = RECORD_SIZE): number {
  const records = Math.max(1, Math.ceil(plainSize / recordSize));
  return HEADER_SIZE + plainSize + records * TAG_SIZE;
}

export function passwordVerifier(password: string, linkId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password.normalize('NFC'), passwordSalt(linkId), PBKDF2_ITERATIONS, 32, 'sha256', (error, key) =>
      error ? reject(error) : resolve(key.toString('base64url')),
    );
  });
}

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashSecret(secret: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(secret, salt, 32, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export function verifySecret(stored: string | null, secret: string): boolean {
  const match = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([\w-]+)\$([\w-]+)$/.exec(stored ?? '');
  if (!match) return false;
  const [, N, r, p, salt, hash] = match as unknown as [string, string, string, string, string, string];
  const expected = Buffer.from(hash, 'base64url');
  const actual = crypto.scryptSync(secret, Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(expected, actual);
}

export function loadOrCreateKey(file: string): Buffer {
  if (fs.existsSync(file)) {
    const key = fs.readFileSync(file);
    if (key.length !== 32) throw new Error(`${file} must contain exactly 32 bytes`);
    return key;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key, { mode: 0o600, flag: 'wx' });
  return key;
}

/** Link keys and other secrets at rest, encrypted with the master key. */
export class Vault {
  private readonly atRest: Buffer;
  private readonly tickets: Buffer;

  constructor(masterKey: Buffer) {
    this.atRest = hkdf(masterKey, Buffer.alloc(0), 'pi-share/v1/at-rest');
    this.tickets = hkdf(masterKey, Buffer.alloc(0), 'pi-share/v1/ticket');
  }

  seal(plain: Buffer, context: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.atRest, iv);
    cipher.setAAD(Buffer.from(context));
    return Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]).toString('base64url');
  }

  open(sealed: string, context: string): Buffer {
    const data = Buffer.from(sealed, 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.atRest, data.subarray(0, 12));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(data.subarray(data.length - TAG_SIZE));
    return Buffer.concat([decipher.update(data.subarray(12, data.length - TAG_SIZE)), decipher.final()]);
  }

  signTicket<T extends { exp: number }>(data: T): string {
    const body = Buffer.from(JSON.stringify(data)).toString('base64url');
    const mac = crypto.createHmac('sha256', this.tickets).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  readTicket<T extends { exp: number }>(ticket: string | undefined, now = Date.now()): T | null {
    const [body, mac] = (ticket ?? '').split('.');
    if (!body || !mac) return null;
    const expected = crypto.createHmac('sha256', this.tickets).update(body).digest();
    const actual = Buffer.from(mac, 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    try {
      const data = JSON.parse(Buffer.from(body, 'base64url').toString()) as T;
      return data.exp > now ? data : null;
    } catch {
      return null;
    }
  }
}
