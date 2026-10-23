import type { RemoteError } from '../../../shared/api.ts';
import type { Translate } from '../../lib/i18n.ts';

/** A failure with an outside server in the admin's language; what the server itself said comes after. */
export function describeRemote(t: Translate, error: RemoteError): string {
  if (error.code === 'status') return t('remote.status', { status: error.detail ?? '?' });
  const text = t(`remote.${error.code}`);
  return error.detail ? `${text}: ${error.detail}` : text;
}
