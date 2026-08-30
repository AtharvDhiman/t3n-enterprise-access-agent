/**
 * Path resolution.
 *
 * `config/policies.yaml` and the audit journal are repo-root-relative, but the
 * server can legitimately be launched from several different working
 * directories:
 *
 *   - `npm start` / `npm run dev:server` — npm sets cwd to `apps/server`
 *   - `npx tsx apps/server/src/index.ts` — cwd is the repo root
 *   - systemd with `WorkingDirectory=/srv/t3n-aca` — cwd is the deploy root
 *
 * Resolving against `process.cwd()` therefore works from the repo root and
 * fails everywhere else, which is exactly the trap this module exists to close:
 * the documented commands were the ones that broke.
 *
 * Instead we locate the project root by walking up from this file until we find
 * the directory that actually contains `config/policies.yaml`. That is
 * launch-directory independent, and an explicit absolute `POLICY_PATH` or
 * `AUDIT_LOG_PATH` still overrides it for deployments that place config
 * elsewhere.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "config/policies.yaml";
/** Enough to climb out of `apps/server/src` from any sane layout. */
const MAX_LEVELS = 8;

/**
 * The directory containing `config/`.
 *
 * Checks `process.cwd()` first so a deployment that lays the tree out
 * differently still works, then walks up from this module's own location.
 * Falls back to cwd, which produces the clear "cannot read policy file at …"
 * error rather than a confusing one.
 */
export function findProjectRoot(): string {
  if (existsSync(resolve(process.cwd(), MARKER))) return process.cwd();

  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < MAX_LEVELS; i++) {
    if (existsSync(resolve(dir, MARKER))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break; // hit the filesystem root
    dir = parent;
  }
  return process.cwd();
}

export const PROJECT_ROOT = findProjectRoot();

/** Resolve a possibly-relative configured path against the project root. */
export function resolveFromRoot(path: string): string {
  return isAbsolute(path) ? path : resolve(PROJECT_ROOT, path);
}

/**
 * Names declared in `.env` that an ambient environment variable is overriding.
 *
 * `dotenv` deliberately does not overwrite variables already present in the
 * process environment — correct for deployment, where systemd or a secret
 * manager should win. Locally it is a trap: an `OPENAI_API_KEY` exported in a
 * shell profile silently beats the one in `.env`, and the only symptom is a
 * bare HTTP 4xx from a provider. That happened during development, so the
 * server now names it at startup instead of leaving it to be rediscovered.
 *
 * Only variable *names* are returned — never values.
 */
export function shadowedEnvNames(envPath: string, environment: NodeJS.ProcessEnv): string[] {
  let text: string;
  try {
    text = readFileSync(envPath, "utf8");
  } catch {
    return [];
  }

  const shadowed: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    const fileValue = line.slice(eq + 1).trim();
    // A blank entry in .env is a placeholder, not an intent to override.
    if (fileValue === "") continue;
    const live = environment[name];
    if (live !== undefined && live !== fileValue) shadowed.push(name);
  }
  return shadowed;
}
