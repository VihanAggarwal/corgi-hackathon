/**
 * The one error shape every route returns. Track C.
 *
 * WHY A TYPE AND NOT A THROW
 * An unhandled throw in an App Router handler becomes an HTML error page in
 * development and an opaque 500 in production, and the client that receives it
 * has to guess from the status code what went wrong. Worse, the default page
 * carries the stack, which on the recommend path means the packet, the dish
 * rows, and occasionally a constraint value land in a browser tab. Everything
 * that can fail here fails as an ApiError, which serializes to one machine
 * readable envelope and never carries an internal message.
 *
 * WHAT NEVER GOES IN A MESSAGE
 * No constraint value, no theta, no reliability, no twin identity, no raw row.
 * The message is written for the developer holding the client, not for a log,
 * and it is safe to render.
 */

/** Every failure a route can report. Clients may switch on these. */
export type ApiErrorCode =
  | 'invalid_body'
  | 'invalid_query'
  | 'not_found'
  | 'rate_limited'
  | 'unauthorized'
  | 'unavailable'
  | 'internal';

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    /** Safe to show. Never contains a value read out of the database. */
    message: string;
    /** The request field at fault, when one field is at fault. */
    field?: string;
  };
}

const STATUS: Record<ApiErrorCode, number> = {
  invalid_body: 400,
  invalid_query: 400,
  not_found: 404,
  rate_limited: 429,
  unauthorized: 401,
  // 503 rather than 500: "no corpus, no credentials, nothing to serve" is a
  // state the caller can retry out of, and a 500 tells them to file a bug.
  unavailable: 503,
  internal: 500,
};

/**
 * A failure a route handler may throw and the wrapper will serialize.
 *
 * Guarantees: carries a code that maps to a fixed status, and a message that
 * was written by us rather than extracted from a caught exception.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly field?: string;

  constructor(code: ApiErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.field = field;
  }
}

/** HTTP status for a code. Exported so tests assert the mapping, not the number. */
export function statusForCode(code: ApiErrorCode): number {
  return STATUS[code];
}

/**
 * Serialize an error to a Response.
 *
 * Guarantees: the body is exactly ApiErrorBody, the status matches the code,
 * and `Retry-After` is set on a rate limit so a client can back off correctly
 * instead of hammering.
 */
export function jsonError(error: ApiError, retryAfterSeconds?: number): Response {
  const body: ApiErrorBody = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.field ? { field: error.field } : {}),
    },
  };
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (error.code === 'rate_limited' && retryAfterSeconds != null) {
    headers['retry-after'] = String(Math.max(1, Math.ceil(retryAfterSeconds)));
  }
  return new Response(JSON.stringify(body), { status: statusForCode(error.code), headers });
}

/**
 * Serialize a successful payload.
 *
 * No caching anywhere in this API. Every response is scoped to one device or
 * one user, and a shared cache in front of a device-scoped response serves one
 * person's palate to the next person on the same edge node.
 */
export function jsonOk<T>(payload: T, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}
