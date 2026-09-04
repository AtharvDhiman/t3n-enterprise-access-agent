/**
 * Point the SDK at `T3N_BASE_URL` when one is set.
 *
 * The server honours this variable (`packages/t3n/src/config.ts`) but the
 * operator CLIs did not, so an operator who pointed the app at a specific node
 * still had `t3n:setup` and `t3n:seed` talking to the environment's default.
 * Provisioning and seeding then landed on one node while the running app read
 * another, and the only symptom was a live evaluation finding no claims — with
 * nothing anywhere to suggest the two were looking at different places.
 *
 * Lives in its own module rather than in `t3n-connect.ts` because that file
 * runs its `main()` on import; a shared helper must not drag a connectivity
 * check along with it.
 */

import { setNodeUrl } from "@terminal3/t3n-sdk";

/** Returns the override that was applied, or null when none was set. */
export function applyBaseUrlOverride(): string | null {
  const override = process.env.T3N_BASE_URL?.trim();
  if (!override) return null;

  // Matches the server's rule: the SDK refuses to relay a credential over an
  // insecure transport, and failing here is clearer than failing mid-handshake.
  if (!/^https:\/\//i.test(override)) {
    console.error("T3N_BASE_URL must use https — refusing to relay a credential over an insecure transport.");
    process.exit(1);
  }

  setNodeUrl(override);
  return override;
}
