/**
 * The route wrapper. Track C.
 *
 * Every handler in app/api/** is a thin call into withApiHandler, so an
 * ApiError thrown anywhere in the body becomes the one typed envelope
 * lib/api/errors.ts defines, and anything else thrown becomes a generic
 * 'internal' rather than a raw stack or an error message reaching a client.
 * See lib/api/errors.ts for why the type is the enforcement mechanism and a
 * try/catch alone is not.
 */

import { ApiError, jsonError } from './errors';
import { RateLimitedError } from './rate-limit';

export async function withApiHandler(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RateLimitedError) {
      return jsonError(new ApiError('rate_limited', err.message), err.retryAfterSeconds);
    }
    if (err instanceof ApiError) {
      return jsonError(err);
    }
    // Anything else is a bug, not a client mistake, and its message is not
    // safe to show: a thrown Postgres error or a validator detail can quote
    // packet content. Never forward err.message here.
    return jsonError(new ApiError('internal', 'Something went wrong handling this request.'));
  }
}
