/**
 * Loading and validating the policy configuration.
 *
 * Separated from evaluation so that evaluation is a pure function of
 * (config, request, claims) and can be unit-tested without touching a disk.
 */

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { PolicyInvalidError } from "@t3n-aca/core";
import { PolicyFileSchema, type PolicyFile } from "./schema.ts";

/** Render zod issues as a readable, line-oriented list. */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => {
      const path = i.path.length > 0 ? i.path.join(".") : "(root)";
      return `  • ${path}: ${i.message}`;
    })
    .join("\n");
}

/** Validate an already-parsed object. Exported for tests and hot-reload. */
export function validatePolicyConfig(raw: unknown): PolicyFile {
  const result = PolicyFileSchema.safeParse(raw);
  if (!result.success) {
    throw new PolicyInvalidError(`\n${formatIssues(result.error)}`, {
      publicMessage: "The policy configuration is invalid.",
      remediation: `Fix config/policies.yaml:\n${formatIssues(result.error)}`,
      internal: { issues: result.error.issues },
    });
  }
  return result.data;
}

/** Parse YAML text into a validated config. */
export function parsePolicyConfig(text: string): PolicyFile {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new PolicyInvalidError(
      `YAML syntax error: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return validatePolicyConfig(raw);
}

/** Read and validate the config from disk. */
export async function loadPolicyConfig(path: string): Promise<PolicyFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new PolicyInvalidError(`cannot read policy file at ${path}`, {
      remediation: `Ensure config/policies.yaml exists at ${path}.`,
      cause: err,
    });
  }
  return parsePolicyConfig(text);
}
