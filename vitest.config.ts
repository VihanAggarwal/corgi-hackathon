import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Vitest needs the "@/" alias spelled out.
 *
 * tsconfig paths are a TYPE-only mapping: tsc resolves them, and Next resolves
 * them at build time, but vitest does neither. Without this, any test touching
 * a module that imports "@/core" fails at import with "Failed to resolve
 * import", which reads as a broken module rather than a missing alias.
 *
 * This bit during the Track C build: route handlers import from "@/core" by
 * convention, so every route test would have failed for a reason that had
 * nothing to do with the routes.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    // Route handlers and core are plain Node. Nothing here needs a DOM, and
    // jsdom would only slow the suite down.
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['node_modules/**', '.next/**'],
  },
});
