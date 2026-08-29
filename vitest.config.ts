import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * Tests run directly against TypeScript sources — there is no build step in
 * this repo, so there is also no compiled artefact for tests to drift from.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@t3n-aca/core": resolve(__dirname, "packages/core/src/index.ts"),
      "@t3n-aca/policy-engine": resolve(__dirname, "packages/policy-engine/src/index.ts"),
      "@t3n-aca/t3n": resolve(__dirname, "packages/t3n/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Live Terminal 3 calls are never made from the unit suite: it must pass
    // in CI, offline, with no credentials.
    env: { CLAIM_SOURCE: "demo", LOG_LEVEL: "silent" },
  },
});
