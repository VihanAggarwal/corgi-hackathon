/**
 * POST /api/enterprise/dinner. Track C. See docs/TRACK-C-MERGE-BRIEF.md.
 *
 * The only HTTP surface for E1. Everything that matters about hard rule 3
 * happens inside planTeamDinner (lib/enterprise/dinner.ts) before this file
 * ever sees a candidate list: consent gate, then the constraint set
 * intersection, then ranking, then one renderer call per venue. This handler
 * does not reorder any of that and does not add a second copy of it. Its job
 * is small: parse the request, rate limit it, hand it to the planner, and
 * translate whatever comes back into an HTTP response with no new field added
 * along the way. withApiHandler (lib/api/handler.ts) is the same wrapper every
 * other route in this API uses, so an ApiError thrown anywhere below becomes
 * the one typed error envelope and nothing here has to remember to catch it.
 *
 * WHY REQUEST VALIDATION IS NOT DUPLICATED HERE
 * validateDinnerRequest already inspects the parsed body with typeof checks on
 * every field, regardless of what TypeScript believes the shape is. The cast
 * below is unchecked at compile time on purpose: the runtime check is the real
 * one, and writing a second, route-local validator would be two rules that can
 * drift, which is exactly what lib/db/constraints.ts's own comment warns
 * against for the filter.
 *
 * WHAT NEVER HAPPENS HERE
 * No caught error's message is ever put in a response body. A provider
 * failure, a database error, or a malformed HRIS row can all legitimately
 * carry Article 9 detail in their message text (see agent-handler.ts and
 * constraints.ts), so a planTeamDinner failure that is not our own
 * DinnerRequestError is reported with one fixed, generic sentence rather than
 * forwarded.
 */

import type { EnterpriseDinnerRequest, EnterpriseDinnerResult } from '@/contracts/types';
import { ApiError, jsonOk } from '@/lib/api/errors';
import { withApiHandler } from '@/lib/api/handler';
import { clientAddress } from '@/lib/api/identity';
import { enforceRateLimit, LIMITS } from '@/lib/api/rate-limit';
import { parseJsonObject } from '@/lib/api/validate';
import {
  DinnerRequestError,
  planTeamDinner,
  sealDinnerResult,
  validateDinnerRequest,
} from '@/lib/enterprise/dinner';
import { defaultDinnerDishSource } from '@/lib/enterprise/dishes';
import { defaultOrgMemberSource } from '@/lib/enterprise/members';
import { defaultOrgAccountToken } from '@/lib/enterprise/org';

export async function POST(request: Request): Promise<Response> {
  return withApiHandler(async () => {
    const body = await parseJsonObject(request);

    // Unchecked cast. See the file header: validateDinnerRequest is the real
    // check, and it runs against the actual runtime value regardless of what
    // this line tells the compiler.
    const dinnerRequest = body as unknown as EnterpriseDinnerRequest;

    const problems = validateDinnerRequest(dinnerRequest);
    if (problems.length > 0) {
      throw new ApiError('invalid_body', problems.join('; '));
    }

    // Keyed by org and by address rather than by attendee, because the caller
    // here is an organizer acting for a whole roster, not one of the attendees.
    enforceRateLimit(
      `enterprise_dinner|org:${dinnerRequest.orgId}|addr:${clientAddress(request)}`,
      LIMITS.enterpriseDinner,
    );

    let result: EnterpriseDinnerResult;
    try {
      const accountToken = await defaultOrgAccountToken(dinnerRequest.orgId);
      result = await planTeamDinner(dinnerRequest, {
        dishes: defaultDinnerDishSource(),
        members: defaultOrgMemberSource(),
        accountToken,
      });
    } catch (error) {
      if (error instanceof DinnerRequestError) {
        throw new ApiError('invalid_body', error.problems.join('; '));
      }
      // A provider failure, a database error, an unreadable HRIS response.
      // Every one of these can legitimately carry constraint detail in its
      // message, so none of them are echoed. See
      // lib/resilience/degradation.ts for why redaction happens at the point a
      // detail is captured rather than here: this route has no way to redact
      // something it never receives.
      throw new ApiError('unavailable', 'Could not plan a dinner for this organization right now.');
    }

    // Sealed once already inside planTeamDinner. Sealing again here is
    // deliberate belt and braces at the one point this object is actually
    // serialized onto the wire: a route handler that later spread an extra
    // field into the body before returning it would be caught here rather
    // than shipped. jsonOk also sets cache-control: no-store, which matters
    // here as much as anywhere else in this API: the response is scoped to
    // one org's roster.
    return jsonOk<EnterpriseDinnerResult>(sealDinnerResult(result));
  });
}
