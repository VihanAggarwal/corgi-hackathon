/**
 * Menu photo to order tests. Track C.
 *
 * No ANTHROPIC_API_KEY is set anywhere in this file. Every test either runs
 * the deterministic stub path or injects `read` and `extract`, so the whole
 * suite is real coverage with zero network calls and zero flakiness from a
 * live model's mood.
 *
 * The three scenarios the build asked for are named exactly, so a reviewer
 * can find them without reading the whole file:
 *   - "a menu with unreadable items produces the hedged reply"
 *   - "a clean menu produces a grounded recommendation naming only dishes
 *      present in the input"
 *   - "low confidence on the user's driving axes triggers the honesty path"
 */

import { afterEach, describe, expect, it } from 'vitest';
import { AXIS_COUNT, AXIS_KEYS, type AxisKey } from '../../contracts/axes';
import type { Conf24, Vec24 } from '../../contracts/types';
import type { ConstraintRow } from '../../lib/db';
import type { ExtractionResult } from '../../scripts/corpus/extract';
import {
  MenuPhotoError,
  __testing,
  assessReadability,
  drivingAxes,
  menuPhotoToOrder,
  normalizePhoto,
  parseRead,
  resetVisionClient,
  stubRead,
  type MenuOrderInput,
  type MenuOrderOptions,
  type MenuRead,
  type ReadMenuItem,
} from './index';

/**
 * Force the "no credentials" path regardless of what is in the ambient
 * environment. This module's own dry-run tests depend on that state
 * specifically, and a real .env.local landing partway through the build
 * (which happened during this build) must not make them flaky: they test a
 * behavior, not an accident of what happens to be configured right now.
 */
async function withNoModelCredentials<T>(fn: () => Promise<T>): Promise<T> {
  const saved = {
    anthropic: process.env.ANTHROPIC_API_KEY,
    gatewayUrl: process.env.MERGE_GATEWAY_BASE_URL,
    gatewayKey: process.env.MERGE_GATEWAY_API_KEY,
    renderDryRun: process.env.RENDER_DRY_RUN,
  };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.MERGE_GATEWAY_BASE_URL;
  delete process.env.MERGE_GATEWAY_API_KEY;
  // scripts/corpus/config.ts loads .env.local on its own first import, which
  // refills ANTHROPIC_API_KEY out from under this test the moment extraction
  // runs (dotenv fills only what is missing, and the delete above just made it
  // missing again). RENDER_DRY_RUN short-circuits the renderer's own key check
  // ahead of that race, so this test cannot turn into a live network call no
  // matter which lazy import happens to run first.
  process.env.RENDER_DRY_RUN = '1';
  resetVisionClient();
  try {
    return await fn();
  } finally {
    if (saved.anthropic !== undefined) process.env.ANTHROPIC_API_KEY = saved.anthropic;
    if (saved.gatewayUrl !== undefined) process.env.MERGE_GATEWAY_BASE_URL = saved.gatewayUrl;
    if (saved.gatewayKey !== undefined) process.env.MERGE_GATEWAY_API_KEY = saved.gatewayKey;
    if (saved.renderDryRun === undefined) delete process.env.RENDER_DRY_RUN;
    else process.env.RENDER_DRY_RUN = saved.renderDryRun;
    resetVisionClient();
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** 24 numbers, a base value with named overrides by axis index. */
function vec(base: number, overrides: Record<number, number> = {}): Vec24 {
  const out = new Array(AXIS_COUNT).fill(base);
  for (const [i, v] of Object.entries(overrides)) out[Number(i)] = v;
  return out;
}

function conf(base: number, overrides: Record<number, number> = {}): Conf24 {
  return vec(base, overrides);
}

const CHILI_HEAT_IDX = AXIS_KEYS.indexOf('heat_capsaicin');

function extraction(key: string, phi: Vec24, confidence: Conf24): ExtractionResult {
  return { key, phi, confidence, maskedAxes: [], abstainedEntirely: false };
}

async function order(
  input: Partial<MenuOrderInput> & { photo?: MenuOrderInput['photo'] } = {},
  options: MenuOrderOptions = {},
) {
  return menuPhotoToOrder(
    { photo: { base64: 'ZmFrZS1tZW51LWJ5dGVz' }, ...input },
    { render: { dryRun: true }, ...options },
  );
}

// ---------------------------------------------------------------------------
// The three required scenarios
// ---------------------------------------------------------------------------

describe('a menu with unreadable items produces the hedged reply', () => {
  it('a photo the vision pass could not turn into any dish returns an honest refusal', async () => {
    const result = await order(
      {},
      {
        read: async (): Promise<MenuRead> => ({
          venueName: null,
          items: [],
          unreadableLineCount: 6,
          stub: false,
        }),
      },
    );

    expect(result.status).toBe('unreadable');
    expect(result.picks).toHaveLength(0);
    expect(result.preface).toMatch(/cannot make out a single dish/i);
    expect(result.read.itemsSeen).toBe(0);
    expect(result.read.unreadableLineCount).toBe(6);
    expect(result.constraintsAppliedCount).toBe(0);
  });

  it('never throws for a garbled photo, it returns a status', async () => {
    await expect(
      order(
        {},
        {
          read: async () => {
            throw new MenuPhotoError('unreadable_response', 'The menu read did not parse.');
          },
        },
      ),
    ).resolves.toMatchObject({ status: 'degraded' });
  });
});

describe('a clean menu produces a grounded recommendation naming only dishes present in the input', () => {
  const items: ReadMenuItem[] = [
    { name: 'Dan Dan Noodles', description: 'chili oil, minced pork, sichuan peppercorn', priceCents: 1400, legibility: 0.95 },
    { name: 'Egg Fried Rice', description: 'plain, mild, comfort food', priceCents: 1100, legibility: 0.9 },
  ];

  const results: ExtractionResult[] = [
    extraction('k0', vec(0, { [CHILI_HEAT_IDX]: 2.8 }), conf(0.9)),
    extraction('k1', vec(0, { [CHILI_HEAT_IDX]: -1.5 }), conf(0.9)),
  ];

  it('names only dishes from the photo, and each pick text names the dish it is about', async () => {
    const theta = vec(0, { [CHILI_HEAT_IDX]: 2.5 });

    const result = await order(
      { theta },
      {
        read: async (): Promise<MenuRead> => ({ venueName: 'Test Kitchen', items, unreadableLineCount: 0, stub: false }),
        extract: async () => results,
      },
    );

    expect(result.status).toBe('ok');
    expect(result.preface).toBeNull();
    expect(result.picks.length).toBeGreaterThan(0);

    const menuNames = new Set(items.map((i) => i.name));
    for (const pick of result.picks) {
      expect(menuNames.has(pick.dishName)).toBe(true);
      expect(pick.text).toContain(pick.dishName);
      // Nothing invented: no venue, dish, or neighborhood outside this fixture.
      expect(pick.text).not.toMatch(/Lower East|Hunan Slurp|liang pi/i);
    }
  });

  it('applies constraints as a set intersection before extraction, and reports only a count', async () => {
    const shellfishItems: ReadMenuItem[] = [
      { name: 'Shrimp Toast', description: 'fried shrimp paste on brioche', priceCents: 900, legibility: 0.9 },
      { name: 'Cucumber Salad', description: 'smashed cucumber, garlic, black vinegar', priceCents: 700, legibility: 0.9 },
    ];
    const rows: ConstraintRow[] = [
      { userId: 'u1', kind: 'allergy', value: 'shellfish', consentedAt: '2026-07-25T00:00:00.000Z' },
    ];

    const result = await order(
      { userId: 'u1' },
      {
        read: async (): Promise<MenuRead> => ({ venueName: 'V', items: shellfishItems, unreadableLineCount: 0, stub: false }),
        extract: async (menuItems) => menuItems.map((it) => extraction(it.key, vec(0), conf(0.9))),
        constraintRows: rows,
      },
    );

    expect(result.constraintsAppliedCount).toBe(1);
    expect(result.picks.some((p) => p.dishName === 'Shrimp Toast')).toBe(false);
    // The privacy boundary this pipeline sits in front of: no trace of the
    // constraint value anywhere in what left the function.
    expect(JSON.stringify(result).toLowerCase()).not.toContain('shellfish');
  });
});

describe("low confidence on the user's driving axes triggers the honesty path", () => {
  const items: ReadMenuItem[] = [
    { name: 'Mystery Plate One', description: 'a description that says nothing about heat', priceCents: 1200, legibility: 0.8 },
    { name: 'Mystery Plate Two', description: 'another description that says nothing about heat', priceCents: 1300, legibility: 0.8 },
  ];

  it('names the unmeasured axis instead of guessing, even though the menu itself read fine', async () => {
    const theta = vec(0, { [CHILI_HEAT_IDX]: 2.5 });
    // Confidence is HIGH everywhere except the one axis this user's ordering
    // turns on. The photo was legible; this user's question was not answered.
    const lowOnDrivingAxis: ExtractionResult[] = items.map((_, i) =>
      extraction(`k${i}`, vec(0), conf(0.9, { [CHILI_HEAT_IDX]: 0.2 })),
    );

    const result = await order(
      { theta },
      {
        read: async (): Promise<MenuRead> => ({ venueName: 'V', items, unreadableLineCount: 0, stub: false }),
        extract: async () => lowOnDrivingAxis,
      },
    );

    expect(result.status).toBe('unreadable');
    expect(result.picks).toHaveLength(0);
    expect(result.preface).toContain('chili heat');
    expect(result.preface).toMatch(/what your ordering turns on/i);
    // The menu itself was fully legible: this is not the "bad photo" hedge.
    expect(result.read.itemsSeen).toBe(2);
    expect(result.read.unreadableLineCount).toBe(0);
  });

  it('a menu that is partly readable for this user gets picks plus an honest count, not silence', async () => {
    const theta = vec(0, { [CHILI_HEAT_IDX]: 2.5 });
    const threeItems: ReadMenuItem[] = [
      ...items,
      { name: 'Mapo Tofu', description: 'numbing and hot, sichuan pepper, minced pork', priceCents: 1500, legibility: 0.9 },
    ];
    const mixedConfidence: ExtractionResult[] = [
      extraction('k0', vec(0), conf(0.9, { [CHILI_HEAT_IDX]: 0.2 })),
      extraction('k1', vec(0), conf(0.9, { [CHILI_HEAT_IDX]: 0.2 })),
      extraction('k2', vec(0, { [CHILI_HEAT_IDX]: 2.9 }), conf(0.9, { [CHILI_HEAT_IDX]: 0.95 })),
    ];

    const result = await order(
      { theta },
      {
        read: async (): Promise<MenuRead> => ({ venueName: 'V', items: threeItems, unreadableLineCount: 0, stub: false }),
        extract: async () => mixedConfidence,
      },
    );

    expect(result.picks.length).toBeGreaterThan(0);
    expect(result.picks.every((p) => p.dishName === 'Mapo Tofu')).toBe(true);
    expect(result.preface).toMatch(/I can only read 1 of 3/i);
    expect(result.status).toBe('partial');
  });
});

// ---------------------------------------------------------------------------
// No credentials, still demoable
// ---------------------------------------------------------------------------

describe('no model credentials configured', () => {
  afterEach(() => {
    resetVisionClient();
  });

  it('degrades to a deterministic stub reply and says so in the reply', async () => {
    const result = await withNoModelCredentials(() =>
      menuPhotoToOrder({ photo: { base64: 'c29tZS1tZW51LXBob3RvLWJ5dGVz' } }),
    );

    expect(result.read.stub).toBe(true);
    // 'unreadable' when the synthetic stub extraction happens to clear no
    // dish past the coverage floor, 'degraded' otherwise. Either is correct:
    // what this test is actually pinning down is that no key means no live
    // call and an honest disclosure, not the exact hash-derived coverage
    // number the stub extractor lands on for this photo.
    expect(['degraded', 'unreadable']).toContain(result.status);
    expect(result.preface).toMatch(/no model credentials configured/i);
  });

  it('is deterministic: the same photo bytes pick the same stub menu every time', () => {
    const a = stubRead({ base64: 'abcdefgh' });
    const b = stubRead({ base64: 'abcdefgh' });
    expect(a.venueName).toBe(b.venueName);
    expect(a.items.map((i) => i.name)).toEqual(b.items.map((i) => i.name));
  });
});

// ---------------------------------------------------------------------------
// normalizePhoto: the input gate
// ---------------------------------------------------------------------------

describe('normalizePhoto', () => {
  it('rejects an empty payload', () => {
    expect(() => normalizePhoto({ base64: '' })).toThrowError(MenuPhotoError);
    try {
      normalizePhoto({ base64: '   ' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MenuPhotoError);
      expect((err as MenuPhotoError).code).toBe('empty_image');
    }
  });

  it('unwraps a data URL and infers the media type from it', () => {
    const { base64, mediaType } = normalizePhoto({ base64: 'data:image/png;base64,aGVsbG8=' });
    expect(base64).toBe('aGVsbG8=');
    expect(mediaType).toBe('image/png');
  });

  it('an explicit mediaType wins over the data URL prefix', () => {
    const { mediaType } = normalizePhoto({
      base64: 'data:application/octet-stream;base64,aGVsbG8=',
      mediaType: 'image/webp',
    });
    expect(mediaType).toBe('image/webp');
  });

  it('rejects an unsupported media type', () => {
    try {
      normalizePhoto({ base64: 'aGVsbG8=', mediaType: 'application/pdf' });
      expect.unreachable();
    } catch (err) {
      expect((err as MenuPhotoError).code).toBe('unsupported_media_type');
    }
  });

  it('rejects an image over the size ceiling', () => {
    // Comfortably over 5MB once decoded.
    const huge = 'A'.repeat(8_000_000);
    try {
      normalizePhoto({ base64: huge });
      expect.unreachable();
    } catch (err) {
      expect((err as MenuPhotoError).code).toBe('image_too_large');
    }
  });

  it('rejects a payload that is not base64', () => {
    try {
      normalizePhoto({ base64: 'not base64 at all!!' });
      expect.unreachable();
    } catch (err) {
      expect((err as MenuPhotoError).code).toBe('empty_image');
    }
  });
});

// ---------------------------------------------------------------------------
// parseRead: coercing a model response
// ---------------------------------------------------------------------------

describe('parseRead', () => {
  it('drops a malformed item and counts it as unreadable rather than throwing', () => {
    const read = parseRead(
      JSON.stringify({
        venue_name: 'Bistro',
        unreadable_lines: 1,
        items: [
          { name: 'Real Dish', description: null, price_cents: 1200, legibility: 0.8 },
          { name: '', description: 'no name, dropped' },
          { notADish: true },
        ],
      }),
    );
    expect(read.items).toHaveLength(1);
    expect(read.items[0].name).toBe('Real Dish');
    // 1 stated, plus 2 dropped entries.
    expect(read.unreadableLineCount).toBe(3);
    expect(read.stub).toBe(false);
  });

  it('strips a markdown fence a model was told not to use', () => {
    const read = parseRead('```json\n{"items":[{"name":"Toast"}]}\n```');
    expect(read.items.map((i) => i.name)).toEqual(['Toast']);
  });

  it('throws MenuPhotoError on text that is not JSON', () => {
    expect(() => parseRead('not json at all')).toThrowError(MenuPhotoError);
  });

  it('clamps an absurd or negative price to null rather than trusting it', () => {
    const read = parseRead(
      JSON.stringify({ items: [{ name: 'Free Water', price_cents: -5 }, { name: 'Gold Plate', price_cents: 5_000_000 }] }),
    );
    expect(read.items.map((i) => i.priceCents)).toEqual([null, null]);
  });
});

// ---------------------------------------------------------------------------
// Readability: the mechanism behind the honesty path
// ---------------------------------------------------------------------------

describe('drivingAxes and assessReadability', () => {
  it('a near-zero theta has no driving axes', () => {
    expect(drivingAxes(vec(0))).toEqual([]);
  });

  it('picks the axes theta is furthest from zero on, by magnitude not sign', () => {
    const theta = vec(0, { [CHILI_HEAT_IDX]: -2, [AXIS_KEYS.indexOf('acid')]: 1.8 });
    const idx = drivingAxes(theta);
    expect(idx[0]).toBe(CHILI_HEAT_IDX);
  });

  it('a cold-start user with a zero theta is judged against all 24 axes uniformly', () => {
    const dishes = [{ confidence: conf(0.9) }, { confidence: conf(0) }];
    const { coverage, readableIdx } = assessReadability(vec(0), dishes);
    expect(coverage[0]).toBeCloseTo(1, 5);
    expect(coverage[1]).toBeCloseTo(0, 5);
    expect(readableIdx).toEqual([0]);
  });
});

describe('internal helpers', () => {
  it('joinLabels reads like prose for one, two, and three axes', () => {
    const heat: AxisKey = 'heat_capsaicin';
    const acid: AxisKey = 'acid';
    const salt: AxisKey = 'salt';
    expect(__testing.joinLabels([heat])).toBe('chili heat');
    expect(__testing.joinLabels([heat, acid])).toBe('chili heat and acidity');
    expect(__testing.joinLabels([heat, acid, salt])).toBe('chili heat, acidity, and salt level');
  });
});
