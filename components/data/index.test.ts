/**
 * components/data (the swap module) tests. Track C.
 *
 * These do not hit a real HTTP server. They stub global fetch to dispatch
 * straight into the real Route Handlers under app/api/**, the same POST/GET
 * functions Next.js would call, so a wiring bug (wrong path, wrong body shape,
 * misreading a response field) fails here for the same reason it would fail
 * in the browser. The fixture-fallback tests then break that dispatch on
 * purpose and assert the fixture path, which is the guarantee this whole pass
 * exists to keep: a route outage must never surface as an empty screen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as cardReadGET } from "@/app/api/card/[cardId]/route";
import { POST as cardCreatePOST } from "@/app/api/card/create/route";
import { POST as compareRoutePOST } from "@/app/api/compare/route";
import { POST as duelAnswerPOST } from "@/app/api/duel/answer/route";
import { POST as duelNextPOST } from "@/app/api/duel/next/route";
import { GET as portraitGET } from "@/app/api/portrait/route";
import { GET as profileGET } from "@/app/api/profile/route";
import { POST as recommendPOST } from "@/app/api/recommend/route";
import { resetRateLimits } from "@/lib/api/rate-limit";
import { resetStoreForTests } from "@/lib/store/memory";
import { DISHES, DUEL_PAIRS, SEED_CARDS } from "@/components/mock/fixtures";
import {
  IS_SEEDED,
  dishCount,
  getComparison,
  getDemoCardId,
  getDemoEvents,
  getDishView,
  getDuelBlock,
  getPortrait,
  getRecommendation,
  getRecommendations,
  getRegionStates,
  getShareCard,
  getTwinStatus,
  submitDuel,
} from "./index";

/** URL prefix components/data/index.ts builds for a server-side (no window) fetch. */
const ORIGIN = "http://localhost:3000";

/**
 * Routes real requests from components/data's fetch calls into the actual
 * exported Route Handlers, so these tests exercise real route logic rather
 * than a second, hand-maintained copy of it.
 */
function dispatch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input.toString();
  const pathname = new URL(url).pathname;
  const request = new Request(url, init);

  if (pathname === "/api/duel/next") return duelNextPOST(request);
  if (pathname === "/api/duel/answer") return duelAnswerPOST(request);
  if (pathname === "/api/profile") return profileGET(request);
  if (pathname === "/api/portrait") return portraitGET(request);
  if (pathname === "/api/recommend") return recommendPOST(request);
  if (pathname === "/api/card/create") return cardCreatePOST(request);
  if (pathname === "/api/compare") return compareRoutePOST(request);
  const cardMatch = pathname.match(/^\/api\/card\/([^/]+)$/);
  if (cardMatch) {
    return cardReadGET(request, { params: Promise.resolve({ cardId: cardMatch[1] }) });
  }
  throw new Error(`test dispatcher has no route for ${pathname}`);
}

/** Every call fails: what components/data must see to take the fixture path. */
async function offlineFetch(): Promise<Response> {
  throw new Error("simulated network failure");
}

const ENV_KEYS = ["ANTHROPIC_API_KEY"] as const;
let savedEnv: Record<string, string | undefined> = {};
let savedRenderDryRun: string | undefined;
let savedPortraitDryRun: string | undefined;

beforeEach(() => {
  resetStoreForTests();
  resetRateLimits();
  vi.stubGlobal("fetch", dispatch);

  // A real ANTHROPIC_API_KEY lives in .env.local for this repo. Left alone,
  // getPortrait/getRecommendations would make real, billed, flaky network
  // calls every time this file runs. Force both dry-run paths exactly like
  // app/api/agent/menu/route.test.ts does, so this suite always exercises the
  // deterministic path a judge with no key configured would actually see.
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  savedRenderDryRun = process.env.RENDER_DRY_RUN;
  savedPortraitDryRun = process.env.PORTRAIT_DRY_RUN;
  process.env.RENDER_DRY_RUN = "1";
  process.env.PORTRAIT_DRY_RUN = "1";
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  if (savedRenderDryRun === undefined) delete process.env.RENDER_DRY_RUN;
  else process.env.RENDER_DRY_RUN = savedRenderDryRun;
  if (savedPortraitDryRun === undefined) delete process.env.PORTRAIT_DRY_RUN;
  else process.env.PORTRAIT_DRY_RUN = savedPortraitDryRun;
});

describe("getDuelBlock", () => {
  it("returns real pairs shaped as DishView from /api/duel/next", async () => {
    const pairs = await getDuelBlock(4);
    expect(pairs.length).toBe(4);
    for (const p of pairs) {
      expect(p.pairId).toBeTruthy();
      expect(typeof p.a.name).toBe("string");
      expect(typeof p.a.venueName).toBe("string");
      expect(typeof p.b.name).toBe("string");
      // dishId is the join key the rest of the app keys everything off of.
      expect(DISHES.some((d) => d.id === p.a.dishId)).toBe(true);
      expect(DISHES.some((d) => d.id === p.b.dishId)).toBe(true);
    }
  });

  it("falls back to the fixture block, never an error, when the route is unreachable", async () => {
    vi.stubGlobal("fetch", offlineFetch);
    const pairs = await getDuelBlock(3, 0);
    expect(pairs.length).toBe(3);
    expect(pairs[0].pairId).toBe("p_0_0");
  });
});

describe("submitDuel", () => {
  it("is recorded by the real store via /api/duel/answer", async () => {
    await submitDuel({
      deviceId: "devtestwire01",
      dishA: DUEL_PAIRS[0][0],
      dishB: DUEL_PAIRS[0][1],
      winner: DUEL_PAIRS[0][0],
      surface: "demo",
    });

    const res = await profileGET(new Request(`${ORIGIN}/api/profile?deviceId=devtestwire01`));
    const body = (await res.json()) as { userVector: { nComparisons: number } };
    expect(body.userVector.nComparisons).toBeGreaterThan(0);
  });

  it("never throws when the write fails, because the next duel must not wait on it", async () => {
    vi.stubGlobal("fetch", offlineFetch);
    await expect(
      submitDuel({
        deviceId: "devtestwire02",
        dishA: "d1",
        dishB: "d2",
        winner: "d1",
        surface: "feed",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("getShareCard", () => {
  it("reads a real card created through /api/card/create", async () => {
    const created = await cardCreatePOST(
      new Request(`${ORIGIN}/api/card/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "devtestwire03", dishA: "d1", dishB: "d2", winner: "d1" }),
      }),
    );
    const { cardId } = (await created.json()) as { cardId: string };

    const share = await getShareCard(cardId);
    expect(share).not.toBeNull();
    expect(share?.card.cardId).toBe(cardId);
    // The real route carries no display name (device-only identity). "Someone"
    // is the honest answer, matching the fixture's own fallback, not a bug.
    expect(share?.senderFirstName).toBe("Someone");
    expect(share?.senderPickedDishId).toBe("d1");
  });

  it("falls back to a seeded card when the route is unreachable", async () => {
    vi.stubGlobal("fetch", offlineFetch);
    const share = await getShareCard(SEED_CARDS[0].cardId);
    expect(share?.card.cardId).toBe(SEED_CARDS[0].cardId);
  });

  it("returns a fixture card rather than null for an id that matches nothing real", async () => {
    // getShareCard's own fallback rule ("cardId match, or the first seeded
    // card") applies even when the network is fine but the id is unknown to
    // both the live store and the fixtures: a bad link must never dead-end.
    const share = await getShareCard("not-a-real-card-id");
    expect(share).not.toBeNull();
  });
});

describe("getPortrait", () => {
  it("produces a real, unflattering-containing portrait with no credentials", async () => {
    const portrait = await getPortrait();
    expect(portrait.body.length).toBeGreaterThan(0);
    expect(portrait.containsUnflattering).toBe(true);
    // Hard rule 6.
    expect(portrait.body).not.toMatch(/!/);
  });

  it("falls back to the fixture portrait when the route is unreachable", async () => {
    vi.stubGlobal("fetch", offlineFetch);
    const portrait = await getPortrait();
    expect(portrait.userId).toBe("u_local");
  });
});

describe("getRegionStates", () => {
  it("reports a real, established-false cold start before and the live region after", async () => {
    const { before, after } = await getRegionStates();
    expect(before.volume).toBe(0);
    expect(after.measuredAt).toBeTruthy();
  });

  it("falls back to the fixture pair when the route is unreachable", async () => {
    vi.stubGlobal("fetch", offlineFetch);
    const { before, after } = await getRegionStates();
    expect(before.volume).toBeCloseTo(3.41);
    expect(after.volume).toBeCloseTo(4.86);
  });
});

describe("getTwinStatus", () => {
  it("is honestly off for a fresh device rather than the fixture's always-on default", async () => {
    const status = await getTwinStatus();
    expect(status.enabled).toBe(false);
  });

  it("degrades to off, never a faked on, when the route is unreachable", async () => {
    vi.stubGlobal("fetch", offlineFetch);
    const status = await getTwinStatus();
    expect(status.enabled).toBe(false);
  });

  it("still honors the twins-disabled kill switch without touching the network", async () => {
    process.env.NEXT_PUBLIC_TWINS_DISABLED = "1";
    try {
      const status = await getTwinStatus();
      expect(status.enabled).toBe(false);
      expect(status.reason).toBe("need_more_duels");
    } finally {
      delete process.env.NEXT_PUBLIC_TWINS_DISABLED;
    }
  });
});

describe("getRecommendations / getRecommendation", () => {
  it("renders real, content-channel recommendations for a fresh device", async () => {
    const recs = await getRecommendations();
    expect(recs.length).toBeGreaterThan(0);
    for (const r of recs) {
      expect(r.sourceChannel).toBe("content");
      expect(r.text).not.toMatch(/!/);
    }
  });

  it("falls back to fixture recommendations, filtered by twin status, when unreachable", async () => {
    vi.stubGlobal("fetch", offlineFetch);
    const recs = await getRecommendations();
    expect(recs.length).toBeGreaterThan(0);
    expect(recs.every((r) => r.sourceChannel !== "twin")).toBe(true);
  });

  it("getRecommendation returns the first recommendation when the id does not match", async () => {
    const all = await getRecommendations();
    const found = await getRecommendation("no-such-packet-id");
    expect(found?.packetId).toBe(all[0]?.packetId ?? null);
  });
});

describe("getDishView / dishCount", () => {
  it("looks dishes up from the shared corpus, not a network call", async () => {
    vi.stubGlobal("fetch", offlineFetch);
    const dish = await getDishView("d1");
    expect(dish?.dishId).toBe("d1");
    expect(dishCount()).toBe(DISHES.length);
  });

  it("returns null for an unknown id rather than throwing", async () => {
    await expect(getDishView("not-a-dish")).resolves.toBeNull();
    await expect(getDishView(null)).resolves.toBeNull();
  });
});

describe("getComparison", () => {
  it("computes a real comparison against the card's creator", async () => {
    const created = await cardCreatePOST(
      new Request(`${ORIGIN}/api/card/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "devtestwire04", dishA: "d1", dishB: "d2", winner: "d1" }),
      }),
    );
    const { cardId } = (await created.json()) as { cardId: string };

    const result = await getComparison(cardId);
    expect(result.verdictText.length).toBeGreaterThan(0);
    expect(typeof result.areTwins).toBe("boolean");
  });

  it("falls back to a fixture comparison when the route is unreachable", async () => {
    vi.stubGlobal("fetch", offlineFetch);
    const agree = await getComparison("p4w9r");
    expect(agree.areTwins).toBe(true);
    const disagree = await getComparison("k3n7q");
    expect(disagree.areTwins).toBe(false);
  });
});

describe("getDemoCardId", () => {
  it("creates one real card and reuses it across calls in this process", async () => {
    const first = await getDemoCardId();
    const second = await getDemoCardId();
    expect(first).toBe(second);

    const res = await cardReadGET(
      new Request(`${ORIGIN}/api/card/${first}`),
      { params: Promise.resolve({ cardId: first }) },
    );
    expect(res.status).toBe(200);
  });
});

describe("getDemoEvents", () => {
  it("stays fixture-only: no activity route exists to wire it to", async () => {
    vi.stubGlobal("fetch", offlineFetch);
    const events = await getDemoEvents();
    expect(events.length).toBeGreaterThan(0);
  });
});

describe("IS_SEEDED", () => {
  it("is false now that live routes are the primary path", () => {
    expect(IS_SEEDED).toBe(false);
  });
});
