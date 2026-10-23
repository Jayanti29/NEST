export type RingLinkRequestStatus = 'valid' | 'malformed' | 'expired';

/** Validate Ring's millisecond timestamp and HMAC nonce shape/freshness before account matching. */
export function validateRingLinkRequest(time: string, nonce: string, now = Date.now()): RingLinkRequestStatus {
  if (!/^\d{13}$/.test(time) || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) return 'malformed';
  const issuedAt = Number(time);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > now || now - issuedAt > 600_000) return 'expired';
  return 'valid';
}
