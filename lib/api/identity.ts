/**
 * Who is asking. Track C.
 *
 * THE DEVICE IS A REAL IDENTITY, NOT A DEGRADED ONE
 * The growth loop of this product is a person tapping a link in a message
 * thread with no app, no account, and no intention of making one. That person
 * plays ten duels and gets a real profile. Every route therefore accepts a
 * device fingerprint alone, and `userId` is the optional field. Code that
 * treats the device path as the fallback ends up putting a sign-up wall
 * somewhere, which is the one thing this product cannot have.
 *
 * A FINGERPRINT IS NOT A SECRET
 * It is chosen by the client and can be copied by anyone who sees it. It scopes
 * data, it does not authenticate. Nothing behind it is Article 9, nothing behind
 * it is another person's, and nothing behind it is a number about a human. When
 * accounts land, the userId path gets a real session check and this stays as
 * the anonymous tier.
 */

import { ApiError } from './errors';
import { requireString, optionalString } from './validate';

export interface Identity {
  /** Always present. This is the anchor for a person with no account. */
  deviceId: string;
  /** Present only once someone has made an account. */
  userId: string | null;
}

/**
 * Opaque and character restricted, because this string becomes a map key, a
 * rate limit key, and part of a log line. Track B generates sixteen hex
 * characters, and its two failure fallbacks ("server", "ephemeral") match too.
 */
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const USER_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

const DEVICE_HINT =
  '"deviceId" must be 4 to 64 characters of letters, digits, hyphen or underscore.';

/**
 * Resolve identity from an already-parsed body or query object.
 *
 * Guarantees: throws ApiError('invalid_body') when the device id is missing or
 * malformed, and never invents one. A route that silently generated a device id
 * for a caller who forgot to send one would write every anonymous request into
 * a different profile, which reads as "the app forgot my answers".
 */
export function resolveIdentity(source: Record<string, unknown>): Identity {
  const deviceId = requireString(source, 'deviceId', {
    min: 4,
    max: 64,
    pattern: DEVICE_ID_RE,
    patternHint: DEVICE_HINT,
  });
  const userId = optionalString(source, 'userId', {
    min: 4,
    max: 64,
    pattern: USER_ID_RE,
    patternHint: '"userId" must be 4 to 64 characters of letters, digits, hyphen or underscore.',
  });
  return { deviceId, userId };
}

/**
 * The storage key for an identity.
 *
 * A user id wins when present so that the same person on two devices sees one
 * profile. Otherwise the device is the subject in its own right, prefixed so a
 * device id can never collide with a user id.
 */
export function identityKey(identity: Identity): string {
  return identity.userId ? `user:${identity.userId}` : `device:${identity.deviceId}`;
}

/**
 * The client address, as far as the platform will tell us.
 *
 * Only the first entry of x-forwarded-for is used. The rest of that header is
 * appended by intermediaries and is attacker controlled, so treating the whole
 * string as the key would let one caller mint unlimited rate limit buckets.
 */
export function clientAddress(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  const real = request.headers.get('x-real-ip');
  if (real) return real.trim().slice(0, 64);
  return 'unknown';
}

/**
 * The rate limit key for a request.
 *
 * Device first, address second. Keying on address alone would throttle a whole
 * office or a whole carrier NAT as one caller, and keying on device alone would
 * be free to defeat by generating a new fingerprint per request, so the address
 * is what backstops an identity the caller controls. Prefixed by route so a
 * burst of duels cannot spend the recommend budget.
 */
export function rateLimitKey(route: string, request: Request, identity: Identity | null): string {
  const subject = identity ? identityKey(identity) : `addr:${clientAddress(request)}`;
  return `${route}|${subject}`;
}

/** True when the string could be a device id. Used before touching a store. */
export function isDeviceId(value: string): boolean {
  return DEVICE_ID_RE.test(value);
}

/** Assert a device id read from somewhere other than a request body. */
export function assertDeviceId(value: string, field: string): string {
  if (!DEVICE_ID_RE.test(value)) {
    throw new ApiError('invalid_body', DEVICE_HINT, field);
  }
  return value;
}
