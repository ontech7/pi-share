import type { RemoteError } from '../shared/api.ts';

const MAX_DETAIL = 200;

/** Thrown with what the admin should read about a failed exchange with an outside server. */
export class RemoteFailure extends Error {
  readonly code: RemoteError['code'];
  /** Kept whole until `remoteError` redacts it, so a cut never splits a secret in two. */
  readonly detail: string | null;

  constructor(code: RemoteError['code'], detail: string | null = null) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

/**
 * What went wrong, from fetch's, zlib's and nodemailer's own errors, without their full (English) wording: the
 * admin translates the code and shows at most what the server itself said, with `secret` blanked out first.
 */
export function remoteError(error: unknown, secret = ''): RemoteError {
  const shown = (detail: string | null | undefined) =>
    detail ? (secret ? detail.split(secret).join('***') : detail).slice(0, MAX_DETAIL) : null;
  if (error instanceof RemoteFailure) return { code: error.code, detail: shown(error.detail) };
  const { name, code, response } = (error ?? {}) as { name?: string; code?: string; response?: string };
  if (name === 'TimeoutError' || code === 'ETIMEDOUT') return { code: 'timeout', detail: null };
  if (code === 'EAUTH') return { code: 'auth', detail: shown(response) };
  if (code === 'EENVELOPE' || code === 'EMESSAGE') return { code: 'rejected', detail: shown(response) };
  if (code?.startsWith('Z_')) return { code: 'invalid', detail: null };
  return { code: 'unreachable', detail: null };
}
