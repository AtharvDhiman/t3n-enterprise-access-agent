/**
 * Project-root path resolution.
 *
 * Regression cover for a bug that made `npm start` and `npm run dev` — the two
 * commands the README leads with — fail outright. npm runs a workspace script
 * with cwd set to the workspace, so resolving `config/policies.yaml` against
 * `process.cwd()` looked for it under `apps/server/`. It was invisible in
 * development because the server had only ever been launched from the repo root.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { findProjectRoot, resolveFromRoot } from "../apps/server/src/paths";
import { REPO_ROOT } from "./helpers";

const originalCwd = process.cwd();
afterEach(() => process.chdir(originalCwd));

describe("project root detection", () => {
  it("finds the directory that actually holds config/policies.yaml", () => {
    expect(existsSync(resolve(findProjectRoot(), "config/policies.yaml"))).toBe(true);
  });

  it("still finds it when cwd is a workspace, as npm sets it", () => {
    process.chdir(resolve(REPO_ROOT, "apps/server"));
    expect(existsSync(resolve(findProjectRoot(), "config/policies.yaml"))).toBe(true);
  });

  it("still finds it when cwd is somewhere unrelated", () => {
    process.chdir(resolve(REPO_ROOT, "packages/core/src"));
    expect(existsSync(resolve(findProjectRoot(), "config/policies.yaml"))).toBe(true);
  });

  it("resolves a relative configured path to a real file", () => {
    expect(existsSync(resolveFromRoot("config/policies.yaml"))).toBe(true);
  });

  it("leaves an absolute path untouched, so deployments can place config anywhere", () => {
    const absolute = resolve(REPO_ROOT, "config/policies.yaml");
    expect(resolveFromRoot(absolute)).toBe(absolute);
  });
});
