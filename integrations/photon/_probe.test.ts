import { describe, expect, it } from 'vitest';
import { fitTheta } from '@/core';

describe('alias probe', () => {
  it('resolves @/core', () => {
    expect(typeof fitTheta).toBe('function');
  });
});
