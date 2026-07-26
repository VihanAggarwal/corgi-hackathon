/**
 * Tests for degradation notices and the redactor. Track C.
 */

import { describe, expect, it } from 'vitest';
import {
  DEGRADATION_LOG_CAPACITY,
  clearDegradations,
  describeError,
  recentDegradations,
  recordDegradation,
  redact,
} from './degradation';

describe('redact', () => {
  it('strips an Anthropic-shaped key out of a message', () => {
    const out = redact('request failed with key sk-ant-abcdefgh12345678');
    expect(out).not.toContain('sk-ant-abcdefgh12345678');
    expect(out).toContain('sk-ant-[redacted]');
  });

  it('strips a query string, since that is where a fetch error usually carries a key', () => {
    const out = redact('GET https://api.example.com/v1/thing?api_key=supersecretvalue123 failed');
    expect(out).not.toContain('supersecretvalue123');
  });

  it('bounds the length of a very long message', () => {
    // Short, space-separated tokens so this exercises the length cap rather
    // than the long-opaque-token secret pattern, which would redact the
    // whole run down to one short placeholder before length ever mattered.
    const out = redact('word '.repeat(1000));
    expect(out.length).toBeLessThanOrEqual(243); // MAX_DETAIL_LENGTH + '...'
  });
});

describe('describeError', () => {
  it('never throws, even for a circular object', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => describeError(circular)).not.toThrow();
    expect(describeError(circular).length).toBeGreaterThan(0);
  });

  it('describes a plain Error with its name and message', () => {
    class CustomTimeout extends Error {}
    const err = new CustomTimeout('took too long');
    expect(describeError(err)).toContain('took too long');
  });
});

describe('the degradation log', () => {
  it('is bounded and drops the oldest entry first', () => {
    clearDegradations();
    for (let i = 0; i < DEGRADATION_LOG_CAPACITY + 10; i++) {
      recordDegradation({
        dependency: `dep-${i}`,
        reason: 'error',
        detail: 'x',
        attempts: 1,
        at: new Date().toISOString(),
      });
    }
    const all = recentDegradations(DEGRADATION_LOG_CAPACITY + 10);
    expect(all.length).toBe(DEGRADATION_LOG_CAPACITY);
    // Newest first, and the earliest ten entries were evicted.
    expect(all[0].dependency).toBe(`dep-${DEGRADATION_LOG_CAPACITY + 9}`);
    expect(all.some((n) => n.dependency === 'dep-0')).toBe(false);
  });

  it('returns a copy, so a caller cannot mutate the buffer', () => {
    clearDegradations();
    recordDegradation({ dependency: 'x', reason: 'error', detail: 'y', attempts: 1, at: 'now' });
    const first = recentDegradations();
    first.push({ dependency: 'injected', reason: 'error', detail: 'z', attempts: 1, at: 'now' });
    expect(recentDegradations().some((n) => n.dependency === 'injected')).toBe(false);
  });
});
