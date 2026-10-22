import type { Lang } from './i18n.ts';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes: number, lang: Lang): string {
  if (bytes < 1024) return `${bytes} B`;
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toLocaleString(lang, { maximumFractionDigits: value < 10 ? 1 : 0 })} ${UNITS[exponent]}`;
}

export function formatDate(ms: number, lang: Lang): string {
  return new Date(ms).toLocaleDateString(lang, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDateTime(ms: number, lang: Lang): string {
  return new Date(ms).toLocaleString(lang, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 30],
  ['month', 12],
  ['year', Number.POSITIVE_INFINITY],
];

export function formatRelative(ms: number, lang: Lang, now = Date.now()): string {
  const format = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  let value = (ms - now) / 1000;
  for (const [unit, size] of STEPS) {
    if (Math.abs(value) < size) return format.format(Math.round(value), unit);
    value /= size;
  }
  return format.format(Math.round(value), 'year');
}

export function countryFlag(code: string | null): string {
  if (!code || !/^[A-Z]{2}$/i.test(code) || code.toUpperCase() === 'XX' || code.toUpperCase() === 'T1') return '';
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}
