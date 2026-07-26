/**
 * In-memory demo store tests. Track C.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { generatePopulation } from './population';
import { clearDemoStore, getDemoPopulation, getDemoSeededAt, isSeededHandle, setDemoPopulation } from './store';

afterEach(() => {
  clearDemoStore();
});

describe('the demo store', () => {
  it('starts empty', () => {
    expect(getDemoPopulation()).toBeNull();
    expect(getDemoSeededAt()).toBeNull();
  });

  it('holds whatever was set until cleared', () => {
    const population = generatePopulation({ usersPerArchetype: 2, duelsPerUser: 15, archetypeCount: 1 });
    setDemoPopulation(population, '2026-01-01T00:00:00.000Z');

    expect(getDemoPopulation()).toBe(population);
    expect(getDemoSeededAt()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('is idempotent to clear: clearing an already-empty store is not an error', () => {
    clearDemoStore();
    expect(() => clearDemoStore()).not.toThrow();
    expect(getDemoPopulation()).toBeNull();
  });

  it('defaults seededAt to now when not supplied', () => {
    const population = generatePopulation({ usersPerArchetype: 2, duelsPerUser: 15, archetypeCount: 1 });
    const before = Date.now();
    setDemoPopulation(population);
    const seededAt = getDemoSeededAt();
    expect(seededAt).not.toBeNull();
    expect(Date.parse(seededAt!)).toBeGreaterThanOrEqual(before);
  });
});

describe('isSeededHandle', () => {
  it('recognizes a handle produced by the seed generator', () => {
    expect(isSeededHandle('seed_heat_seeker_00')).toBe(true);
  });

  it('rejects a handle that only happens to contain the word seed', () => {
    expect(isSeededHandle('reseeded_user')).toBe(false);
    expect(isSeededHandle('a_seed_00')).toBe(false);
  });

  it('rejects null, undefined, and non-strings without throwing', () => {
    expect(isSeededHandle(null)).toBe(false);
    expect(isSeededHandle(undefined)).toBe(false);
  });
});
