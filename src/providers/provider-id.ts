export const MAX_PROVIDER_ID_LENGTH = 64;

const SAFE_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/**
 * Token external Provider namespace contract. Provider IDs are the
 * structural prefix of every external model alias, so they must be one
 * slash-free bounded segment before entering the authoritative Catalog.
 */
export function isSafeProviderId(value: string): boolean {
  return value.length <= MAX_PROVIDER_ID_LENGTH && SAFE_PROVIDER_ID.test(value);
}
