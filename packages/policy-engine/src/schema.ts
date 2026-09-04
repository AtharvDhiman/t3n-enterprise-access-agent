/**
 * Schema for `config/policies.yaml`.
 *
 * Strict by design (`.strict()` everywhere): a typo in a policy file is a
 * security-relevant defect, so an unrecognised key is an error rather than a
 * silently ignored line. `require_manual_aproval: true` must never be accepted
 * as "no manual approval required".
 */

import { z } from "zod";
import { ASSURANCE_LEVELS, SUBJECT_TYPES } from "@t3n-aca/core";

/** Identifier shape shared by policy ids, claim ids, resources and levels. */
const Identifier = z
  .string()
  .min(1)
  .max(80)
  .regex(
    /^[a-z][a-z0-9_]*$/,
    "must be lower_snake_case, starting with a letter (e.g. employee_access)",
  );

/** A T3N data scope path, e.g. `compliance/identity`. */
const ScopePath = z
  .string()
  .min(1)
  .max(120)
  .regex(
    /^[a-z][a-z0-9_]*(\/[a-z][a-z0-9_]*)*$/,
    "must be a slash-separated lower_snake_case path (e.g. compliance/identity)",
  );

export const ClaimDefinitionSchema = z
  .object({
    scope: ScopePath,
    label: z.string().min(1).max(120),
    description: z.string().min(1).max(2000),
  })
  .strict();

const BehaviorSchema = z.enum(["review", "deny"]);

export const DefaultsSchema = z
  .object({
    minimum_assurance: z.enum(ASSURANCE_LEVELS),
    max_claim_age_days: z.number().int().positive().max(3650),
    expired_claim_behavior: BehaviorSchema,
    failed_claim_behavior: BehaviorSchema,
    expiring_soon_days: z.number().int().nonnegative().max(365),
  })
  .strict();

/**
 * Per-policy rule overrides. Every field optional — anything omitted inherits
 * from `defaults`, so a policy file stays readable and a global change is one
 * edit rather than N.
 */
export const PolicyRulesSchema = z
  .object({
    minimum_assurance: z.enum(ASSURANCE_LEVELS).optional(),
    max_claim_age_days: z.number().int().positive().max(3650).optional(),
    expired_claim_behavior: BehaviorSchema.optional(),
    failed_claim_behavior: BehaviorSchema.optional(),
    expiring_soon_days: z.number().int().nonnegative().max(365).optional(),
    require_manual_approval: z.boolean().optional(),
    flag_missing_optional: z.boolean().optional(),
  })
  .strict();

export const PolicyDefinitionSchema = z
  .object({
    label: z.string().min(1).max(160),
    description: z.string().min(1).max(2000),
    applies_to_subject_types: z.array(z.enum(SUBJECT_TYPES)).min(1),
    resources: z.array(Identifier).min(1),
    access_levels: z.array(Identifier).min(1),
    required_claims: z.array(Identifier).min(1),
    optional_claims: z.array(Identifier).default([]),
    rules: PolicyRulesSchema.default({}),
  })
  .strict();

export const ResolutionSchema = z
  .object({
    order: z.array(Identifier).min(1),
    no_match_behavior: BehaviorSchema,
  })
  .strict();

export const PolicyFileSchema = z
  .object({
    version: z.string().min(1).max(40),
    claims: z.record(Identifier, ClaimDefinitionSchema),
    defaults: DefaultsSchema,
    policies: z.record(Identifier, PolicyDefinitionSchema),
    resolution: ResolutionSchema,
  })
  .strict()
  // Cross-field integrity: every claim a policy references must be defined, and
  // every policy the resolution order names must exist. Catching this at load
  // time turns a would-be runtime surprise into a startup error.
  .superRefine((file, ctx) => {
    const knownClaims = new Set(Object.keys(file.claims));
    for (const [policyId, policy] of Object.entries(file.policies)) {
      for (const claimId of [...policy.required_claims, ...policy.optional_claims]) {
        if (!knownClaims.has(claimId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["policies", policyId],
            message: `references undefined claim "${claimId}". Define it under \`claims:\`.`,
          });
        }
      }
      const overlap = policy.required_claims.filter((c) =>
        policy.optional_claims.includes(c),
      );
      if (overlap.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["policies", policyId],
          message: `claim(s) listed as both required and optional: ${overlap.join(", ")}`,
        });
      }
    }

    const knownPolicies = new Set(Object.keys(file.policies));
    for (const policyId of file.resolution.order) {
      if (!knownPolicies.has(policyId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["resolution", "order"],
          message: `references undefined policy "${policyId}"`,
        });
      }
    }
    for (const policyId of knownPolicies) {
      if (!file.resolution.order.includes(policyId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["resolution", "order"],
          message: `policy "${policyId}" is never reachable by auto-resolution. Add it to \`resolution.order\`.`,
        });
      }
    }

    // Membership in `resolution.order` is not the same as reachability.
    // `resolvePolicyId` is an ordered first-match, so a policy whose entire
    // (subject type x resource x access level) cross-product is already covered
    // by an earlier entry can never be selected — it is dead config that looks
    // live. This shipped as a real defect: `vendor_readonly_access` sat below
    // `contractor_access`, which is a superset on all three dimensions, so
    // every vendor read resolved to the stricter contractor policy and asked
    // for two scopes it did not need.
    for (let i = 0; i < file.resolution.order.length; i++) {
      const laterId = file.resolution.order[i];
      const later = laterId ? file.policies[laterId] : undefined;
      if (!later) continue;

      for (let j = 0; j < i; j++) {
        const earlierId = file.resolution.order[j];
        const earlier = earlierId ? file.policies[earlierId] : undefined;
        if (!earlier) continue;

        const covers =
          later.applies_to_subject_types.every((t) =>
            earlier.applies_to_subject_types.includes(t),
          ) &&
          later.resources.every((r) => earlier.resources.includes(r)) &&
          later.access_levels.every((l) => earlier.access_levels.includes(l));

        if (covers) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["resolution", "order"],
            message: `policy "${laterId}" is unreachable: "${earlierId}" appears earlier in \`resolution.order\` and already covers every subject type, resource and access level it declares. Move "${laterId}" above "${earlierId}" (most specific first), or narrow "${earlierId}".`,
          });
        }
      }
    }
  });

export type ClaimDefinition = z.infer<typeof ClaimDefinitionSchema>;
export type PolicyDefinition = z.infer<typeof PolicyDefinitionSchema>;
export type PolicyDefaults = z.infer<typeof DefaultsSchema>;
export type PolicyFile = z.infer<typeof PolicyFileSchema>;
