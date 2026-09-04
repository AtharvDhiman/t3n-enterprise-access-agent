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
    // (subject type x resource x access level) cross-product is already claimed
    // by earlier entries can never be selected — it is dead config that looks
    // live. This shipped as a real defect: `vendor_readonly_access` sat below
    // `contractor_access`, which is a superset on all three dimensions, so
    // every vendor read resolved to the stricter contractor policy and asked
    // for two scopes it did not need.
    //
    // The check walks the cross-product, exactly as `resolvePolicyId` does,
    // accumulating the triples each entry is the first to claim. Comparing each
    // policy against ONE earlier policy at a time — the first version of this
    // guard — missed every case where two or more earlier entries jointly cover
    // a later one. Adding a policy that tightens a control (say, requiring an
    // NDA and a named approver for wiki reads by anyone) validated cleanly,
    // appeared in `GET /api/policies`, and governed nothing, while access the
    // operator believed was now gated kept being auto-approved by the looser
    // policies underneath it.
    const claimed = new Map<string, string>();
    const seenInOrder = new Set<string>();

    for (const policyId of file.resolution.order) {
      // A repeated entry used to be compared against itself, which trivially
      // "covered" it and produced the uninterpretable advice to move a policy
      // above itself. Name the actual mistake instead.
      if (seenInOrder.has(policyId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["resolution", "order"],
          message: `policy "${policyId}" is listed more than once in \`resolution.order\`. Remove the duplicate entry — only the first occurrence can ever match.`,
        });
        continue;
      }
      seenInOrder.add(policyId);

      const policy = file.policies[policyId];
      if (!policy) continue;

      const own: string[] = [];
      for (const subjectType of policy.applies_to_subject_types) {
        for (const resource of policy.resources) {
          for (const accessLevel of policy.access_levels) {
            own.push(`${subjectType}|${resource}|${accessLevel}`);
          }
        }
      }

      const shadowedBy = new Set<string>();
      let fresh = 0;
      for (const triple of own) {
        const owner = claimed.get(triple);
        if (owner === undefined) {
          claimed.set(triple, policyId);
          fresh++;
        } else {
          shadowedBy.add(owner);
        }
      }

      if (own.length > 0 && fresh === 0) {
        const owners = [...shadowedBy].map((id) => `"${id}"`).join(", ");
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["resolution", "order"],
          message: `policy "${policyId}" is unreachable: every subject type, resource and access level it declares is already claimed by ${owners}, which appear earlier in \`resolution.order\`. Move "${policyId}" above them (most specific first), or narrow them.`,
        });
      }
    }
  });

export type ClaimDefinition = z.infer<typeof ClaimDefinitionSchema>;
export type PolicyDefinition = z.infer<typeof PolicyDefinitionSchema>;
export type PolicyDefaults = z.infer<typeof DefaultsSchema>;
export type PolicyFile = z.infer<typeof PolicyFileSchema>;
