/**
 * Request validation. Track C.
 *
 * Hand written rather than schema driven, because the dependency list is fixed
 * for this build and a validator that has to be installed is a validator that
 * does not run today. Every helper throws ApiError, never a bare Error, so a
 * malformed body produces a typed 400 and never a stack.
 *
 * TRUST NOTHING FROM THE WIRE
 * Every route here is reachable with no account and no key, which is the whole
 * product and also the whole attack surface. A device id is a string a stranger
 * chose, so it is length capped and character restricted before it is used as a
 * map key, a rate limit key, or part of a share URL.
 */

import { ApiError } from './errors';

/**
 * Parse a JSON object body.
 *
 * Guarantees: returns a plain object, or throws ApiError('invalid_body'). An
 * array, a bare string, and a null body are all rejected, because each of them
 * makes every field read below return undefined and turns a malformed request
 * into a silently empty one.
 */
export async function parseJsonObject(request: Request): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ApiError('invalid_body', 'Body must be JSON.');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError('invalid_body', 'Body must be a JSON object.');
  }
  return raw as Record<string, unknown>;
}

export interface StringRules {
  min?: number;
  max?: number;
  pattern?: RegExp;
  /** Shown when the pattern fails. Written for a developer, never a regex dump. */
  patternHint?: string;
}

/** A trimmed string that satisfies the rules, or ApiError('invalid_body'). */
export function requireString(
  source: Record<string, unknown>,
  field: string,
  rules: StringRules = {},
): string {
  const value = source[field];
  if (typeof value !== 'string') {
    throw new ApiError('invalid_body', `"${field}" is required and must be a string.`, field);
  }
  const trimmed = value.trim();
  const { min = 1, max = 512, pattern, patternHint } = rules;
  if (trimmed.length < min) {
    throw new ApiError('invalid_body', `"${field}" must be at least ${min} characters.`, field);
  }
  if (trimmed.length > max) {
    throw new ApiError('invalid_body', `"${field}" must be at most ${max} characters.`, field);
  }
  if (pattern && !pattern.test(trimmed)) {
    throw new ApiError(
      'invalid_body',
      patternHint ?? `"${field}" is not in the expected format.`,
      field,
    );
  }
  return trimmed;
}

/** Same as requireString, but absent and empty both yield null. */
export function optionalString(
  source: Record<string, unknown>,
  field: string,
  rules: StringRules = {},
): string | null {
  const value = source[field];
  if (value === undefined || value === null || value === '') return null;
  return requireString(source, field, rules);
}

/** A member of `allowed`, or ApiError('invalid_body'). */
export function requireEnum<T extends string>(
  source: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T {
  const value = source[field];
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ApiError(
      'invalid_body',
      `"${field}" must be one of: ${allowed.join(', ')}.`,
      field,
    );
  }
  return value as T;
}

/** A member of `allowed`, or the fallback when the field is absent. */
export function optionalEnum<T extends string>(
  source: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (source[field] === undefined || source[field] === null) return fallback;
  return requireEnum(source, field, allowed);
}

/**
 * A bounded integer, or the fallback when absent.
 *
 * Clamping instead of rejecting is deliberate for counts: a client asking for
 * five hundred duels gets ten rather than a 400, because the ask is legible and
 * refusing it only produces a broken feed. Non-numeric input is still an error,
 * since that is a bug rather than an appetite.
 */
export function boundedInt(
  source: Record<string, unknown>,
  field: string,
  options: { min: number; max: number; fallback: number },
): number {
  const value = source[field];
  if (value === undefined || value === null) return options.fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new ApiError('invalid_body', `"${field}" must be a number.`, field);
  }
  return Math.min(options.max, Math.max(options.min, Math.trunc(n)));
}

/**
 * An optional finite number. Absent, null, or empty string all yield
 * undefined rather than a default, because several callers (theta's
 * nComparisons and posteriorVar) treat "unknown" and "zero" as different
 * facts about a user and must not collapse the two.
 */
export function optionalNumber(source: Record<string, unknown>, field: string): number | undefined {
  const value = source[field];
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new ApiError('invalid_body', `"${field}" must be a number.`, field);
  }
  return n;
}

/**
 * An optional array of exactly `length` finite numbers, or ApiError('invalid_body').
 *
 * The wrong length is rejected rather than padded or truncated: a short theta
 * silently shifts every axis after the point it went missing, which corrupts
 * a ranking in a way nothing downstream can detect.
 */
export function optionalNumberArray(
  source: Record<string, unknown>,
  field: string,
  length: number,
): number[] | undefined {
  const value = source[field];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length !== length) {
    throw new ApiError('invalid_body', `"${field}" must be an array of ${length} numbers.`, field);
  }
  const out = value.map((v) => (typeof v === 'number' ? v : NaN));
  if (out.some((v) => !Number.isFinite(v))) {
    throw new ApiError('invalid_body', `"${field}" must contain only finite numbers.`, field);
  }
  return out;
}

/**
 * Read the query string as the same shape the body helpers accept.
 *
 * GET routes carry their identity in the query, and reusing the body validators
 * keeps one set of rules for "what is a valid device id" rather than two that
 * drift.
 */
export function queryObject(request: Request): Record<string, unknown> {
  const url = new URL(request.url);
  const out: Record<string, unknown> = {};
  url.searchParams.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}
