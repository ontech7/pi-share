import fs from 'node:fs';
import net from 'node:net';
import { pipeline, Readable } from 'node:stream';
import zlib from 'node:zlib';
import type { Provider, ProviderInfo, RemoteError } from '../shared/api.ts';
import { plainAddress } from './network.ts';
import { RemoteFailure, remoteError } from './remote.ts';
import type { Settings } from './settings.ts';

const REFRESH_EVERY = 7 * 24 * 60 * 60 * 1000;
const MAX_DOWNLOAD = 32 * 1024 * 1024;
const MAX_UNPACKED = 256 * 1024 * 1024;
const MIN_RANGES = 1_000;
const MAX_NAME = 100;
/** The real table has about 600,000 ranges and 80,000 networks. */
const MAX_ROWS = 2_000_000;
const MAX_NAMES = 200_000;
const MAX_LINE = 1_024;

/**
 * Networks of clouds, hosting companies and the VPN services that rent from them: a visit from one of these
 * is a server, a bot or a VPN, not somebody's home or phone.
 */
const HOSTING = new Set([
  8075, 9009, 12876, 13335, 14061, 14618, 15169, 16276, 16509, 20473, 24940, 31898, 36352, 45102, 51167, 53667, 60068,
  62240, 63949, 132203, 136907, 212238, 396982,
]);

function ipv4Number(address: string): number | null {
  if (!net.isIPv4(address)) return null;
  return address.split('.').reduce((value, part) => value * 256 + Number(part), 0);
}

/** The first 64 bits of an IPv6 address: providers are never assigned anything smaller than a /64. */
function ipv6Prefix(address: string): bigint | null {
  if (!net.isIPv6(address)) return null;
  const groupsOf = (part: string) => (part ? part.split(':') : []);
  const [head = '', tail] = address.split('::');
  const left = groupsOf(head);
  const right = tail === undefined ? [] : groupsOf(tail);
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return groups.slice(0, 4).reduce((value, group) => (value << 16n) | BigInt(Number.parseInt(group, 16) || 0), 0n);
}

/** "A1TELEKOM-AT A1 Telekom Austria AG" → "A1 Telekom Austria AG": the registry handle says less than the name. */
function displayName(description: string): string {
  const clean = description.replace(/[\p{C}]/gu, '').trim();
  const [handle = '', ...rest] = clean.split(' ');
  const name = rest.length && /^[A-Z\d._-]+$/.test(handle) ? rest.join(' ') : clean;
  return name.slice(0, MAX_NAME);
}

/** Sorted by start, in typed arrays: a full table is about 600,000 ranges and has to fit on a Pi. */
type Columns<T> = { start: ArrayLike<T>; end: ArrayLike<T>; asn: Uint32Array };

/** Rows go straight into typed arrays that double when full, so a table costs a few bytes per range. */
class Column<T extends number | bigint> {
  start: Uint32Array | BigUint64Array;
  end: Uint32Array | BigUint64Array;
  asn = new Uint32Array(1024);
  length = 0;
  /** iptoasn publishes its table in order: noticing it here spares a sort that would hold up the broker. */
  private ordered = true;
  private readonly make: (size: number) => Uint32Array | BigUint64Array;

  constructor(make: (size: number) => Uint32Array | BigUint64Array) {
    this.make = make;
    this.start = make(1024);
    this.end = make(1024);
  }

  push(start: T, end: T, asn: number) {
    if (this.length === this.asn.length) {
      const grow = <A extends Uint32Array | BigUint64Array>(old: A, next: A) => {
        next.set(old as never);
        return next;
      };
      this.start = grow(this.start, this.make(this.length * 2));
      this.end = grow(this.end, this.make(this.length * 2));
      this.asn = grow(this.asn, new Uint32Array(this.length * 2));
    }
    if (this.length > 0 && start < (this.start[this.length - 1] as T)) this.ordered = false;
    this.start[this.length] = start as never;
    this.end[this.length] = end as never;
    this.asn[this.length] = asn;
    this.length++;
  }

  sorted(): Columns<T> {
    if (this.ordered) {
      return {
        start: this.start.slice(0, this.length) as unknown as ArrayLike<T>,
        end: this.end.slice(0, this.length) as unknown as ArrayLike<T>,
        asn: this.asn.slice(0, this.length),
      };
    }
    const start = this.start as unknown as ArrayLike<T>;
    const order = Uint32Array.from({ length: this.length }, (_, index) => index).sort((a, b) => {
      const left = start[a] as T;
      const right = start[b] as T;
      return left < right ? -1 : left > right ? 1 : 0;
    });
    const pick = <A extends Uint32Array | BigUint64Array>(source: A, target: A) => {
      order.forEach((from, to) => {
        target[to] = source[from] as never;
      });
      return target;
    };
    return {
      start: pick(this.start, this.make(this.length)) as unknown as ArrayLike<T>,
      end: pick(this.end, this.make(this.length)) as unknown as ArrayLike<T>,
      asn: pick(this.asn, new Uint32Array(this.length)),
    };
  }
}

function find<T extends number | bigint>(ranges: Columns<T>, value: T): number | null {
  let low = 0;
  let high = ranges.start.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((ranges.start[middle] as T) <= value) low = middle + 1;
    else high = middle - 1;
  }
  return high >= 0 && value <= (ranges.end[high] as T) ? (ranges.asn[high] as number) : null;
}

export class ProviderTable {
  private readonly v4: Columns<number>;
  private readonly v6: Columns<bigint>;
  private readonly names: Map<number, string>;

  constructor(v4: Column<number>, v6: Column<bigint>, names: Map<number, string>) {
    this.v4 = v4.sorted();
    this.v6 = v6.sorted();
    this.names = names;
  }

  get size(): number {
    return this.v4.start.length + this.v6.start.length;
  }

  lookup(ip: string | null | undefined): Provider | null {
    const address = plainAddress(ip);
    const v4 = ipv4Number(address);
    const v6 = v4 === null ? ipv6Prefix(address) : null;
    const asn = v4 !== null ? find(this.v4, v4) : v6 !== null ? find(this.v6, v6) : null;
    if (!asn) return null;
    return { asn, name: this.names.get(asn) ?? `AS${asn}`, hosting: HOSTING.has(asn) };
  }
}

/**
 * Reads iptoasn's "start end asn country description" lines; anything malformed is skipped, never trusted.
 * Rows, names and line length are capped, so a hostile table cannot take the memory the broker shares.
 */
export async function parseTable(gzipped: Readable): Promise<ProviderTable> {
  const v4 = new Column<number>((size) => new Uint32Array(size));
  const v6 = new Column<bigint>((size) => new BigUint64Array(size));
  const names = new Map<number, string>();
  const add = (line: string) => {
    const [first = '', last = '', asnText = '', , description = ''] = line.split('\t');
    const asn = Number(asnText);
    if (!Number.isInteger(asn) || asn <= 0 || asn > 4_294_967_295) return;
    if (v4.length + v6.length >= MAX_ROWS) throw new RemoteFailure('invalid');
    const start4 = ipv4Number(first);
    const end4 = start4 === null ? null : ipv4Number(last);
    if (start4 !== null && end4 !== null && start4 <= end4) v4.push(start4, end4, asn);
    else {
      const start6 = ipv6Prefix(first);
      const end6 = start6 === null ? null : ipv6Prefix(last);
      if (start6 === null || end6 === null || start6 > end6) return;
      v6.push(start6, end6, asn);
    }
    if (!names.has(asn) && description && names.size < MAX_NAMES) names.set(asn, displayName(description));
  };

  const gunzip = zlib.createGunzip();
  // Unlike pipe(), closes the source too when the table is refused halfway, so no file stays open.
  pipeline(gzipped, gunzip, () => undefined);
  gunzip.setEncoding('utf8');
  let unpacked = 0;
  let rest = '';
  for await (const chunk of gunzip as AsyncIterable<string>) {
    unpacked += chunk.length;
    if (unpacked > MAX_UNPACKED) throw new RemoteFailure('too_large');
    const lines = (rest + chunk).split('\n');
    rest = lines.pop() ?? '';
    if (rest.length > MAX_LINE) throw new RemoteFailure('invalid');
    for (const line of lines) add(line);
  }
  if (rest) add(rest);
  return new ProviderTable(v4, v6, names);
}

export type ProvidersDeps = {
  file: string;
  url: string;
  settings: Settings;
  enabledDefault: boolean;
  userAgent: string;
  fetch?: typeof fetch;
  now?: () => number;
};

/** Who runs the network a visitor came from, from a public table kept on this disk: no address leaves it. */
export class Providers {
  private readonly deps: ProvidersDeps;
  private table: ProviderTable | null = null;
  private updatedAt: number | null = null;
  private error: RemoteError | null = null;
  private running: Promise<void> | null = null;
  private loading: Promise<void> | null = null;
  /** Read once: lookups run for every event of a link detail. */
  private enabledNow: boolean | null = null;

  constructor(deps: ProvidersDeps) {
    this.deps = deps;
  }

  private get now() {
    return (this.deps.now ?? Date.now)();
  }

  get enabled(): boolean {
    this.enabledNow ??= this.deps.settings.providers(this.deps.enabledDefault).enabled;
    return this.enabledNow;
  }

  lookup(ip: string | null | undefined): Provider | null {
    return this.enabled ? (this.table?.lookup(ip) ?? null) : null;
  }

  info(): ProviderInfo {
    return {
      enabled: this.enabled,
      ranges: this.table?.size ?? 0,
      updatedAt: this.updatedAt,
      error: this.error,
      // Loading from disk counts: it may be followed by a download, and the page polls only while this is true.
      updating: this.loading !== null || this.running !== null,
    };
  }

  /** Turned off, the table leaves memory; turned on again, it comes back from the disk or a download. */
  setEnabled(enabled: boolean) {
    this.deps.settings.setProviders({ enabled });
    this.enabledNow = enabled;
    if (enabled) void this.start();
    else {
      this.table = null;
      this.updatedAt = null;
      this.error = null;
    }
  }

  /** Loads the table saved on disk, then downloads a fresh one if it is missing or a week old. */
  async start() {
    if (!this.enabled) return;
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    await this.loading;
    await this.maybeRefresh();
  }

  private async load() {
    if (this.table) return;
    const before = this.updatedAt;
    try {
      const stat = fs.statSync(this.deps.file);
      const table = await parseTable(fs.createReadStream(this.deps.file));
      // A download that finished meanwhile is newer than the file read here, and may be turned off since.
      if (this.updatedAt !== before || !this.enabled) return;
      this.table = table;
      this.updatedAt = stat.mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.error = remoteError(error);
    }
  }

  async maybeRefresh() {
    if (!this.enabled || (this.updatedAt !== null && this.now - this.updatedAt < REFRESH_EVERY)) return;
    await this.refresh().catch(() => undefined);
  }

  /** Turned off, nothing is downloaded: the owner opted out of talking to iptoasn. */
  refresh(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    this.running ??= this.download().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async download() {
    try {
      const response = await (this.deps.fetch ?? fetch)(this.deps.url, {
        headers: { 'user-agent': this.deps.userAgent },
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok || !response.body) throw new RemoteFailure('status', String(response.status));
      if (Number(response.headers.get('content-length') ?? 0) > MAX_DOWNLOAD) throw new RemoteFailure('too_large');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_DOWNLOAD) throw new RemoteFailure('too_large');
        chunks.push(Buffer.from(chunk));
      }
      const data = Buffer.concat(chunks);
      const table = await parseTable(Readable.from([data]));
      if (table.size < MIN_RANGES) throw new RemoteFailure('invalid');
      const temporary = `${this.deps.file}.tmp`;
      fs.writeFileSync(temporary, data, { mode: 0o600 });
      fs.renameSync(temporary, this.deps.file);
      if (!this.enabled) return;
      this.table = table;
      this.updatedAt = this.now;
      this.error = null;
    } catch (error) {
      this.error = remoteError(error);
      throw error;
    }
  }
}
