/**
 * Policy configuration loading and validation.
 *
 * The shipped `config/policies.yaml` is validated here, so a typo in the file
 * that operators are *encouraged* to edit fails the build rather than the
 * production request that first hits it.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PolicyEngine, parsePolicyConfig, validatePolicyConfig } from "@t3n-aca/policy-engine";
import { POLICY_PATH } from "./helpers";

/**
 * Loosely typed on purpose: these tests deliberately construct *invalid*
 * configs, so the fixture type must permit shapes the real schema rejects.
 * Typing it as the parsed output would make the negative cases uncompilable.
 */
interface LooseConfig {
  version: string;
  claims: Record<string, { scope: string; label: string; description: string }>;
  defaults: Record<string, unknown>;
  policies: Record<
    string,
    {
      label: string;
      description: string;
      applies_to_subject_types: string[];
      resources: string[];
      access_levels: string[];
      required_claims: string[];
      optional_claims?: string[];
      [key: string]: unknown;
    }
  >;
  resolution: { order: string[]; no_match_behavior: string };
}

const validConfig: LooseConfig = {
  version: "1.0.0",
  claims: {
    identity_verified: {
      scope: "compliance/identity",
      label: "Identity verified",
      description: "x",
    },
  },
  defaults: {
    minimum_assurance: "substantial",
    max_claim_age_days: 365,
    expired_claim_behavior: "review",
    failed_claim_behavior: "deny",
    expiring_soon_days: 30,
  },
  policies: {
    basic_access: {
      label: "Basic",
      description: "x",
      applies_to_subject_types: ["employee"],
      resources: ["wiki"],
      access_levels: ["read"],
      required_claims: ["identity_verified"],
    },
  },
  resolution: { order: ["basic_access"], no_match_behavior: "deny" },
};

describe("the shipped policy file", () => {
  it("is valid", () => {
    expect(() => parsePolicyConfig(readFileSync(POLICY_PATH, "utf8"))).not.toThrow();
  });

  it("defines every policy the four demo decision paths need", () => {
    const engine = new PolicyEngine(parsePolicyConfig(readFileSync(POLICY_PATH, "utf8")));
    for (const id of ["employee_access", "contractor_access", "privileged_access"]) {
      expect(engine.policyIds()).toContain(id);
    }
  });

  it("keeps privileged access behind a manual approver", () => {
    const engine = new PolicyEngine(parsePolicyConfig(readFileSync(POLICY_PATH, "utf8")));
    expect(engine.effectiveRules("privileged_access").requireManualApproval).toBe(true);
  });
});

describe("validation", () => {
  it("accepts a minimal valid config", () => {
    expect(() => validatePolicyConfig(validConfig)).not.toThrow();
  });

  it("rejects a policy that references an undefined claim", () => {
    const bad = structuredClone(validConfig);
    const policy = bad.policies.basic_access;
    if (!policy) throw new Error("fixture is missing basic_access");
    policy.required_claims = ["not_a_real_claim"];
    expect(() => validatePolicyConfig(bad)).toThrowError(/undefined claim/);
  });

  it("rejects a resolution order naming an undefined policy", () => {
    const bad = structuredClone(validConfig);
    bad.resolution.order = ["ghost_policy"];
    expect(() => validatePolicyConfig(bad)).toThrowError(/undefined policy/);
  });

  it("rejects a policy that resolution can never reach", () => {
    const bad = structuredClone(validConfig);
    const base = bad.policies.basic_access;
    if (!base) throw new Error("fixture is missing basic_access");
    bad.policies.orphan = { ...base, label: "Orphan" };
    expect(() => validatePolicyConfig(bad)).toThrowError(/never reachable/);
  });

  it("rejects an unknown key rather than ignoring it", () => {
    // A silently-ignored `require_manual_aproval` typo would disable a control.
    const bad = structuredClone(validConfig);
    const policy = bad.policies.basic_access;
    if (!policy) throw new Error("fixture is missing basic_access");
    policy.require_manual_aproval = true;
    expect(() => validatePolicyConfig(bad)).toThrow();
  });

  it("rejects an invalid assurance level", () => {
    const bad = structuredClone(validConfig);
    bad.defaults.minimum_assurance = "extremely_high";
    expect(() => validatePolicyConfig(bad)).toThrow();
  });

  it("rejects a claim listed as both required and optional", () => {
    const bad = structuredClone(validConfig);
    const policy = bad.policies.basic_access;
    if (!policy) throw new Error("fixture is missing basic_access");
    policy.optional_claims = ["identity_verified"];
    expect(() => validatePolicyConfig(bad)).toThrowError(/both required and optional/);
  });

  it("reports the offending path in the error message", () => {
    const bad = structuredClone(validConfig);
    const policy = bad.policies.basic_access;
    if (!policy) throw new Error("fixture is missing basic_access");
    policy.required_claims = ["nope"];
    try {
      validatePolicyConfig(bad);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("policies.basic_access");
    }
  });

  it("rejects malformed YAML with a readable message", () => {
    expect(() => parsePolicyConfig("version: [unclosed")).toThrowError(/YAML syntax error/);
  });
});
