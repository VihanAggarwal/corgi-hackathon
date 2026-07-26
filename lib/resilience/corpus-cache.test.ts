/**
 * Tests for the local corpus cache. Track C.
 *
 * The property under test is the one in the file's header: the duel feed must
 * never fail, whether or not Track A's checkpoint files exist, and whether or
 * not the network is reachable at all. Every test in the "offline" block below
 * stubs global fetch to reject, so a source that quietly started making a
 * network call would fail loudly here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import {
  getOfflineCorpusSnapshot,
  resetOfflineCorpusCache,
  sampleDuelPairs,
} from './corpus-cache';

const REAL_CHECKPOINTS = join(process.cwd(), 'scripts', 'corpus', '.checkpoints');
const MISSING_DIR = join(process.cwd(), 'scripts', 'corpus', '.does-not-exist-checkpoints');

let originalFetch: typeof fetch;

beforeEach(() => {
  resetOfflineCorpusCache();
  originalFetch = globalThis.fetch;
  // Every test in this file must pass with the network fully unreachable.
  globalThis.fetch = vi.fn(() => Promise.reject(new Error('network must not be used'))) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetOfflineCorpusCache();
});

describe('getOfflineCorpusSnapshot, entirely offline', () => {
  it('reads real venues and dishes from the checked-in checkpoint directory', () => {
    const snapshot = getOfflineCorpusSnapshot({ checkpointDir: REAL_CHECKPOINTS });
    expect(snapshot.source).toBe('checkpoint');
    expect(snapshot.venues.length).toBeGreaterThan(0);
    expect(snapshot.dishes.length).toBeGreaterThan(0);
    // Every dish must point at a venue that is actually in the snapshot.
    const venueIds = new Set(snapshot.venues.map((v) => v.id));
    for (const dish of snapshot.dishes) {
      expect(venueIds.has(dish.venueId)).toBe(true);
    }
  });

  it('never touches the network to do it', () => {
    getOfflineCorpusSnapshot({ checkpointDir: REAL_CHECKPOINTS });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('falls back to the bundled fixture when the checkpoint directory does not exist', () => {
    const snapshot = getOfflineCorpusSnapshot({ checkpointDir: MISSING_DIR });
    expect(snapshot.source).toBe('fixture');
    expect(snapshot.venues.length).toBeGreaterThan(0);
    expect(snapshot.dishes.length).toBeGreaterThan(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('never returns an empty snapshot from either path', () => {
    expect(getOfflineCorpusSnapshot({ checkpointDir: REAL_CHECKPOINTS }).dishes.length).toBeGreaterThan(0);
    expect(getOfflineCorpusSnapshot({ checkpointDir: MISSING_DIR }).dishes.length).toBeGreaterThan(0);
  });

  it('caches the default-directory read so a second call is the same object', () => {
    const first = getOfflineCorpusSnapshot();
    const second = getOfflineCorpusSnapshot();
    expect(second).toBe(first);
    resetOfflineCorpusCache();
    const third = getOfflineCorpusSnapshot();
    expect(third).not.toBe(first);
  });
});

describe('sampleDuelPairs', () => {
  const snapshot = getOfflineCorpusSnapshot({ checkpointDir: MISSING_DIR }); // the fixture, deterministic and small

  it('is deterministic for a given seed', () => {
    const a = sampleDuelPairs(snapshot, 6, 3);
    const b = sampleDuelPairs(snapshot, 6, 3);
    expect(a).toEqual(b);
  });

  it('every pair names two different dishes with a venue and a name', () => {
    const pairs = sampleDuelPairs(snapshot, 10, 1);
    expect(pairs.length).toBe(10);
    for (const pair of pairs) {
      expect(pair.a.dishId).not.toBe(pair.b.dishId);
      expect(pair.a.name.length).toBeGreaterThan(0);
      expect(pair.b.name.length).toBeGreaterThan(0);
      expect(pair.a.venueName.length).toBeGreaterThan(0);
      expect(pair.b.venueName.length).toBeGreaterThan(0);
    }
  });

  it('produces a different feed for a different seed', () => {
    const a = sampleDuelPairs(snapshot, 6, 0);
    const b = sampleDuelPairs(snapshot, 6, 1);
    expect(a).not.toEqual(b);
  });

  it('returns an empty list rather than throwing for a snapshot with under two dishes', () => {
    const tiny = { venues: snapshot.venues.slice(0, 1), dishes: snapshot.dishes.slice(0, 1), source: 'fixture' as const };
    expect(sampleDuelPairs(tiny, 5, 0)).toEqual([]);
  });
});
