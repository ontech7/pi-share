import type { FilePart } from '../../shared/wire.ts';

export type DownloadJob = {
  token: string;
  url: string;
  ticket: string;
  linkId: string;
  part: FilePart;
  key: Uint8Array<ArrayBuffer>;
  name: string;
};

export type ToWorker = { type: 'prepare'; job: DownloadJob } | { type: 'ping' };

export type FromWorker =
  | { type: 'ready'; token: string }
  | { type: 'progress'; token: string; loaded: number; total: number }
  | { type: 'done'; token: string }
  | { type: 'error'; token: string; reason: string; status?: number };

export const DOWNLOAD_PREFIX = '/__download/';
