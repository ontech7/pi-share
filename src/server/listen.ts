import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { listenOptions } from './config.ts';

export async function listen(app: FastifyInstance, address: string, socketMode = 0o660) {
  const options = listenOptions(address);
  if ('path' in options) {
    // sun_path is 104 bytes on macOS and 108 on Linux; longer paths fail in confusing ways
    if (Buffer.byteLength(options.path) > 100) throw new Error(`Socket path too long: ${options.path}`);
    fs.rmSync(options.path, { force: true });
  }
  await app.listen(options);
  if ('path' in options) fs.chmodSync(options.path, socketMode);
}

export function readSecret(file: string): string | null {
  if (!file) return null;
  const value = fs.readFileSync(file, 'utf8').trim();
  if (value.length < 32) throw new Error(`${file} must contain at least 32 characters`);
  return value;
}

export function closeOnSignal(...apps: FastifyInstance[]) {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => {
      await Promise.allSettled(apps.map((app) => app.close()));
      process.exit(0);
    });
  }
}
