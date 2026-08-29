/**
 * Shared test fixtures.
 *
 * Tests load the **real** `config/policies.yaml` rather than a bespoke test
 * policy. That is deliberate: it means the suite fails if someone edits the
 * shipped policy file in a way that breaks a decision path, which is exactly
 * the regression most worth catching in a compliance system.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { AccessRequest, Claim, ClaimSet, ClaimSourceKind } from "@t3n-aca/core";
import { PolicyEngine, parsePolicyConfig } from "@t3n-aca/policy-engine";

export const REPO_ROOT = resolve(__dirname, "..");
export const POLICY_PATH = resolve(REPO_ROOT, "config/policies.yaml");

export function loadRealEngine(): PolicyEngine {
  return new PolicyEngine(parsePolicyConfig(readFileSync(POLICY_PATH, "utf8")));
}

/** A fixed instant, so nothing in the suite depends on the wall clock. */
export const NOW = new Date("2026-08-29T12:00:00.000Z");

const DAY = 86_400_000;
export const daysFromNow = (n: number): string => new Date(NOW.getTime() + n * DAY).toISOString();

export function claim(id: string, overrides: Partial<Claim> = {}): Claim {
  return {
    id,
    verified: true,
    assurance: "high",
    verifiedAt: daysFromNow(-30),
    expiresAt: daysFromNow(300),
    issuerCategory: "government",
    evidenceRef: `vc:sha256:${id}`,
    ...overrides,
  };
}

/** Build a claim set where every requested scope is consented to. */
export function claimSet(
  claims: Claim[],
  options: {
    subjectRef?: string;
    source?: ClaimSourceKind;
    requestedScopes?: string[];
    authorizedScopes?: string[];
    deniedScopes?: string[];
    consentVerified?: boolean;
    unavailableReason?: string | null;
  } = {},
): ClaimSet {
  const requested = options.requestedScopes ?? [];
  const authorized = options.authorizedScopes ?? requested;
  const denied = options.deniedScopes ?? requested.filter((s) => !authorized.includes(s));
  return {
    subjectRef: options.subjectRef ?? "test:subject",
    source: options.source ?? "DEMO_FIXTURE",
    requestedScopes: requested,
    authorizedScopes: authorized,
    deniedScopes: denied,
    claims,
    consentVerified: options.consentVerified ?? denied.length === 0,
    unavailableReason: options.unavailableReason ?? null,
  };
}

export function request(overrides: Partial<AccessRequest> = {}): AccessRequest {
  return {
    subjectRef: "test:subject",
    subjectType: "employee",
    resource: "employee_dashboard",
    accessLevel: "read",
    ...overrides,
  };
}
