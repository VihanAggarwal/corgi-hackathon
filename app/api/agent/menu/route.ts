/**
 * POST /api/agent/menu. Track C.
 *
 * Menu photo to order. This handler is deliberately thin: every decision
 * about what the photo says, what is safe to recommend, and how honest the
 * reply has to be is made in integrations/vision, which is also where Track
 * A's extractor, ranker, packet builder, and renderer are imported from. This
 * file's only job is turning an HTTP request into a MenuOrderInput and a
 * MenuOrderResult back into a Response, so the business logic never has to
 * know it is running inside Next.
 *
 * WHY THIS ROUTE ALMOST NEVER RETURNS A NON-2xx
 * menuPhotoToOrder() already turns a blurry, empty, or unreadable photo into
 * a `degraded` or `unreadable` status carrying a plain-language explanation.
 * That is the honesty requirement, and it belongs in the response body, not
 * in an HTTP error: the request was fine, the world was dark. Only a
 * malformed REQUEST (no device id, no photo field, unparsable body, a theta
 * of the wrong length) is a 4xx here. Anything menuPhotoToOrder itself throws
 * is a bug in this file's contract with it, not something a client caused, so
 * it becomes a redaction-safe 'internal' error rather than a stack trace.
 *
 * ACCEPTS
 * multipart/form-data with an `image` file field, or application/json with a
 * `photo: { base64, mediaType? }` object. Both paths converge on the same
 * MenuPhoto before anything else runs.
 */

import { AXIS_COUNT } from '../../../../contracts/axes';
import {
  menuPhotoToOrder,
  type MenuOrderInput,
  type MenuOrderOptions,
  type MenuPhoto,
} from '../../../../integrations/vision';
import { ApiError, jsonError, jsonOk } from '../../../../lib/api/errors';
import { resolveIdentity, rateLimitKey, type Identity } from '../../../../lib/api/identity';
import { LIMITS, takeToken } from '../../../../lib/api/rate-limit';
import {
  boundedInt,
  optionalNumber,
  optionalNumberArray,
  optionalString,
  parseJsonObject,
} from '../../../../lib/api/validate';

/**
 * Above Anthropic's per-image ceiling with room for base64 overhead and a
 * data URL prefix. A guard here rejects an absurd payload before it is
 * decoded or handed to the vision module at all, which does its own precise
 * byte accounting once the string is known to be a reasonable size.
 */
const MAX_BASE64_CHARS = 8_000_000;

const MAX_TEXT_FIELD = 200;

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

/**
 * Turn a request body into the flat field set both wire formats produce.
 *
 * multipart and JSON converge here so everything below this point is a
 * single validation path, and a bug in one cannot silently diverge from the
 * other.
 */
async function parseRequestFields(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.toLowerCase().includes('multipart/form-data')) {
    return parseMultipart(request);
  }
  return parseJsonObject(request);
}

async function parseMultipart(request: Request): Promise<Record<string, unknown>> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new ApiError('invalid_body', 'Body must be valid multipart form data.');
  }

  const out: Record<string, unknown> = {};
  for (const key of ['deviceId', 'userId', 'venueName', 'neighborhood']) {
    const value = form.get(key);
    if (typeof value === 'string') out[key] = value;
  }
  // Structured fields arrive as JSON text inside a form field. A value that
  // fails to parse is passed through as the raw string, which the numeric and
  // array validators below reject with a field-specific message rather than
  // this function guessing what the caller meant.
  for (const key of ['theta', 'nComparisons', 'posteriorVar', 'maxPicks']) {
    const value = form.get(key);
    if (typeof value === 'string' && value.trim().length > 0) {
      try {
        out[key] = JSON.parse(value);
      } catch {
        out[key] = value;
      }
    }
  }

  const image = form.get('image');
  if (image instanceof File) {
    if (image.size > MAX_BASE64_CHARS) {
      throw new ApiError('invalid_body', 'Image is too large.', 'image');
    }
    const bytes = new Uint8Array(await image.arrayBuffer());
    out.photo = { base64: Buffer.from(bytes).toString('base64'), mediaType: image.type || undefined };
  }

  return out;
}

/** photo.base64 required, photo.mediaType optional. Anything else is a 400. */
function extractPhoto(source: Record<string, unknown>): MenuPhoto {
  const raw = source.photo;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError(
      'invalid_body',
      '"photo" is required and must be an object with a base64 field, or send the image as multipart form data.',
      'photo',
    );
  }
  const rec = raw as Record<string, unknown>;
  const base64 = rec.base64;
  if (typeof base64 !== 'string' || base64.trim().length === 0) {
    throw new ApiError('invalid_body', '"photo.base64" is required and must be a non-empty string.', 'photo.base64');
  }
  if (base64.length > MAX_BASE64_CHARS) {
    throw new ApiError('invalid_body', 'Image payload is too large.', 'photo.base64');
  }
  const mediaType = rec.mediaType;
  if (mediaType !== undefined && mediaType !== null && typeof mediaType !== 'string') {
    throw new ApiError('invalid_body', '"photo.mediaType" must be a string.', 'photo.mediaType');
  }
  return { base64, mediaType: typeof mediaType === 'string' ? mediaType : undefined };
}

interface ParsedMenuRequest {
  identity: Identity;
  input: MenuOrderInput;
  options: MenuOrderOptions;
}

/**
 * Validate a request into exactly what menuPhotoToOrder needs.
 *
 * Guarantees: throws ApiError('invalid_body') for anything a client got
 * wrong, and never passes a theta of the wrong length or a non-finite number
 * further into the pipeline. Everything optional stays undefined rather than
 * defaulted, because menuPhotoToOrder's own cold-start defaults (a zero
 * theta, no expansion claim) are the ones the honesty logic is calibrated
 * against.
 */
async function parseMenuRequest(request: Request): Promise<ParsedMenuRequest> {
  const source = await parseRequestFields(request);
  const identity = resolveIdentity(source);
  const photo = extractPhoto(source);

  const theta = optionalNumberArray(source, 'theta', AXIS_COUNT);
  const nComparisons = optionalNumber(source, 'nComparisons');
  const posteriorVar = optionalNumber(source, 'posteriorVar');
  const venueName = optionalString(source, 'venueName', { max: MAX_TEXT_FIELD });
  const neighborhood = optionalString(source, 'neighborhood', { max: MAX_TEXT_FIELD });
  const maxPicks = boundedInt(source, 'maxPicks', { min: 1, max: 5, fallback: 2 });

  const input: MenuOrderInput = {
    photo,
    ...(theta ? { theta } : {}),
    ...(nComparisons !== undefined ? { nComparisons } : {}),
    ...(posteriorVar !== undefined ? { posteriorVar } : {}),
    ...(venueName ? { venueName } : {}),
    ...(neighborhood ? { neighborhood } : {}),
    ...(identity.userId ? { userId: identity.userId } : {}),
  };

  return { identity, input, options: { maxPicks } };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * A fixed hint rather than the bucket's precise fractional refill time: the
 * exact wait is an implementation detail of the token bucket, and a stable
 * number is easier for a client to reason about than one that jitters with
 * load.
 */
const RATE_LIMIT_RETRY_SECONDS = 30;

export async function POST(request: Request): Promise<Response> {
  try {
    const { identity, input, options } = await parseMenuRequest(request);

    const limit = takeToken(rateLimitKey('agent_menu', request, identity), LIMITS.agentMenu);
    if (!limit.allowed) {
      throw new ApiError('rate_limited', 'Too many menu photos submitted. Wait a moment and try again.');
    }

    const result = await menuPhotoToOrder(input, options);
    return jsonOk(result);
  } catch (err) {
    if (err instanceof ApiError) {
      const retryAfter = err.code === 'rate_limited' ? RATE_LIMIT_RETRY_SECONDS : undefined;
      return jsonError(err, retryAfter);
    }
    // menuPhotoToOrder is documented to degrade rather than throw for anything
    // photo- or extraction-related, so a throw reaching here is this file's
    // own bug, not the caller's. The message is written for a client, so it
    // says nothing about what actually failed.
    return jsonError(new ApiError('internal', 'The menu route could not complete.'));
  }
}
