import type { RemoteError } from '../shared/api.ts';

/** Thrown with what the admin should read about a failed exchange with an outside server. */
export class RemoteFailure extends Error {
  readonly remote: RemoteError;

  constructor(code: RemoteError['code'], detail: string | null = null) {
    super(detail ? `${code}: ${detail}` : code);
    this.remote = { code, detail: detail?.slice(0, 200) ?? null };
  }
}

/**
 * What went wrong, from fetch's, zlib's and nodemailer's own errors, without their full (English) wording: the
 * admin translates the code and shows at most what the server itself said.
 */
export function remoteError(error: unknown): RemoteError {
  if (error instanceof RemoteFailure) return error.remote;
  const { name, code, response } = (error ?? {}) as { name?: string; code?: string; response?: string };
  if (name === 'TimeoutError' || code === 'ETIMEDOUT') return { code: 'timeout', detail: null };
  if (code === 'EAUTH') return { code: 'auth', detail: response?.slice(0, 200) ?? null };
  if (code === 'EENVELOPE' || code === 'EMESSAGE') return { code: 'rejected', detail: response?.slice(0, 200) ?? null };
  if (code?.startsWith('Z_')) return { code: 'invalid', detail: null };
  return { code: 'unreachable', detail: null };
}
