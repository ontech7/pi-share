import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  encryptedSize,
  encryptStream,
  hashSecret,
  passwordVerifier,
  sealMeta,
  Vault,
  verifySecret,
} from '../src/server/crypto.ts';
import { passwordVerifier as browserVerifier, decryptStream, openMeta } from '../src/shared/wire.ts';

const key = crypto.randomBytes(32);
const browserKey = new Uint8Array(key);

function chunked(buffer: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let i = 0; i < buffer.length; ) {
    const size = 1 + Math.floor(Math.random() * 9000);
    parts.push(buffer.subarray(i, i + size));
    i += size;
  }
  return parts;
}

async function encrypt(plain: Buffer, record?: number, part: number | 'all' = 0): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const chunk of Readable.from(chunked(plain)).pipe(encryptStream(key, 'link', part, record)))
    out.push(chunk);
  return Buffer.concat(out);
}

async function decrypt(wire: Buffer, part: number | 'all' = 0): Promise<Buffer> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunked(wire)) controller.enqueue(new Uint8Array(chunk));
      controller.close();
    },
  });
  return Buffer.from(await new Response(source.pipeThrough(decryptStream(browserKey, 'link', part))).arrayBuffer());
}

describe('stream encryption', () => {
  it.each([0, 1, 1023, 1024, 2048, 5000, 3079])('round-trips %i bytes with small records', async (size) => {
    const plain = crypto.randomBytes(size);
    const wire = await encrypt(plain, 1024);
    expect(wire.length).toBe(encryptedSize(size, 1024));
    expect(await decrypt(wire)).toEqual(plain);
  });

  it('round-trips a multi-record file with the default record size', async () => {
    const plain = crypto.randomBytes(300 * 1024 + 5);
    expect(await decrypt(await encrypt(plain))).toEqual(plain);
  });

  it('rejects a flipped byte, a dropped last record, a cut header and the wrong file', async () => {
    const plain = crypto.randomBytes(5000);
    const wire = await encrypt(plain, 1024);
    const flipped = Buffer.from(wire);
    flipped[100] = (flipped[100] as number) ^ 1;
    await expect(decrypt(flipped)).rejects.toThrow('integrity');
    await expect(decrypt(wire.subarray(0, 24 + 4 * (1024 + 16)))).rejects.toThrow('integrity');
    await expect(decrypt(wire.subarray(0, 10))).rejects.toThrow('truncated');
    await expect(decrypt(wire, 1)).rejects.toThrow('integrity');
  });

  it('uses a fresh salt for every download', async () => {
    const plain = Buffer.from('same content');
    expect(await encrypt(plain)).not.toEqual(await encrypt(plain));
  });
});

describe('metadata and passwords', () => {
  it('opens metadata only with the right key and link id', async () => {
    const sealed = sealMeta(key, 'abc', { files: [{ name: 'è.zip', size: 3 }] });
    expect(await openMeta(browserKey, 'abc', sealed)).toEqual({ files: [{ name: 'è.zip', size: 3 }] });
    await expect(openMeta(browserKey, 'abd', sealed)).rejects.toThrow();
    await expect(openMeta(new Uint8Array(crypto.randomBytes(32)), 'abc', sealed)).rejects.toThrow();
  });

  it('derives the same password verifier in the browser and on the server', async () => {
    expect(await browserVerifier('Pàssword 1', 'xyz')).toBe(await passwordVerifier('Pàssword 1', 'xyz'));
    expect(await passwordVerifier('a', 'x')).not.toBe(await passwordVerifier('a', 'y'));
  });

  it('hashes secrets with scrypt', () => {
    const hash = hashSecret('secret');
    expect(verifySecret(hash, 'secret')).toBe(true);
    expect(verifySecret(hash, 'other')).toBe(false);
    expect(verifySecret('garbage', 'secret')).toBe(false);
  });
});

describe('vault', () => {
  const vault = new Vault(crypto.randomBytes(32));

  it('seals values bound to their context', () => {
    const sealed = vault.seal(key, 'link-1');
    expect(vault.open(sealed, 'link-1')).toEqual(key);
    expect(() => vault.open(sealed, 'link-2')).toThrow();
  });

  it('signs tickets that expire and cannot be forged', () => {
    const ticket = vault.signTicket({ l: 'a', exp: Date.now() + 1000 });
    expect(vault.readTicket<{ l: string; exp: number }>(ticket)?.l).toBe('a');
    expect(vault.readTicket(`${ticket.slice(0, -2)}AA`)).toBeNull();
    expect(vault.readTicket(vault.signTicket({ l: 'a', exp: Date.now() - 1 }))).toBeNull();
    expect(new Vault(crypto.randomBytes(32)).readTicket(ticket)).toBeNull();
  });
});
