/**
 * Seed a live Terminal 3 subject: claim records plus the consent that lets the
 * agent read them.
 *
 * This is what a real integration would do from an HR or verification system.
 * Here it runs once so the live demo has something truthful to evaluate.
 *
 * What it writes, in order:
 *
 *   1. **Scope writers** — org-data ACLs default to deny, so the tenant is
 *      declared writer on each compliance scope before anything is written.
 *   2. **Claim records** — minimized assertions: outcome, assurance, dates,
 *      issuer *category*. No names, no documents, no identifiers.
 *   3. **Org grants** — `setGrants` records which scopes the agent DID may read.
 *   4. **Member delegation** — `agentAuthUpdate`, signed by the data owner,
 *      naming the agent and its scopes.
 *
 * Note what is deliberately *not* granted: `compliance/training`. The records
 * exist and the tenant can read them, but the agent has no consent for that
 * scope — so a privileged-access evaluation in live mode produces
 * REVIEW_REQUIRED for a consent reason, which is the behaviour worth showing.
 *
 * The subject here is the tenant's own DID. Terminal 3 documents this
 * self-grant pattern explicitly, and it is what a single-account testnet
 * deployment can honestly demonstrate. In production each subject is their own
 * data owner, holding their own DID and issuing their own grants — the code
 * path is identical; only who signs the grant changes.
 *
 * Idempotent: re-running overwrites the same records rather than duplicating.
 *
 * Run:  npm run t3n:seed
 */

import "dotenv/config";

import {
  T3nClient,
  setEnvironment,
  loadWasmComponent,
  eth_get_address,
  metamask_sign,
  createEthAuthInput,
  fetchTrustedManifest,
  getNodeUrl,
  createOrgDataClientFromSession,
  mergeAgentAuthEntries,
  type AgentAuthEntry,
  type Environment,
  type UserGrant,
} from "@terminal3/t3n-sdk";

import { applyBaseUrlOverride } from "./lib/node-url.ts";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const ok = (m: string) => console.log(`${GREEN}✓${RESET} ${m}`);
const warn = (m: string) => console.log(`${YELLOW}!${RESET} ${m}`);
const fail = (m: string) => console.log(`${RED}✗${RESET} ${m}`);
const info = (m: string) => console.log(`${DIM}  ${m}${RESET}`);

const READ_FUNCTIONS = ["org-data-get", "org-data-list"];

/** Scopes the agent is granted. `compliance/training` is intentionally absent. */
const GRANTED_SCOPES = [
  "compliance/identity",
  "compliance/employment",
  "compliance/company",
  "compliance/contractor",
  "compliance/legal",
];

/** Every scope we write records into. */
const ALL_SCOPES = [...GRANTED_SCOPES, "compliance/training", "compliance/background"];

const DAY = 86_400_000;
function todayUtcStart(): number {
  const n = new Date();
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
}
const at = (days: number) => new Date(todayUtcStart() + days * DAY).toISOString();

interface SeedRecord {
  scope: string;
  claim: string;
  verified: boolean;
  assurance: "none" | "low" | "substantial" | "high";
  verifiedAt: string;
  expiresAt: string;
  issuerCategory: string;
}

const RECORDS: SeedRecord[] = [
  {
    scope: "compliance/identity",
    claim: "identity_verified",
    verified: true,
    assurance: "high",
    verifiedAt: at(-90),
    expiresAt: at(300),
    issuerCategory: "government",
  },
  {
    scope: "compliance/employment",
    claim: "employment_verified",
    verified: true,
    assurance: "high",
    verifiedAt: at(-60),
    expiresAt: at(305),
    issuerCategory: "employer",
  },
  {
    scope: "compliance/training",
    claim: "security_training",
    verified: true,
    assurance: "high",
    verifiedAt: at(-30),
    expiresAt: at(25),
    issuerCategory: "training_provider",
  },
  {
    scope: "compliance/background",
    claim: "background_check",
    verified: true,
    assurance: "high",
    verifiedAt: at(-100),
    expiresAt: at(260),
    issuerCategory: "screening_provider",
  },
];

async function main(): Promise<void> {
  console.log(`\n${BOLD}Seeding live Terminal 3 compliance data${RESET}\n`);

  const envName = (process.env.T3N_ENV?.trim() || "testnet") as Environment;
  const tenantKey = process.env.T3N_API_KEY?.trim();
  const orgDid = process.env.T3N_ORG_DID?.trim();
  const agentDid = process.env.T3N_AGENT_DID?.trim();
  const contractId = process.env.T3N_CONTRACT_ID?.trim() || "tee:org-data/contracts";

  if (!tenantKey || !/^0x[0-9a-fA-F]{64}$/.test(tenantKey)) {
    console.error(`${RED}✗${RESET} T3N_API_KEY missing or invalid.`);
    process.exit(1);
  }
  if (!orgDid || !agentDid) {
    console.error(`${RED}✗${RESET} T3N_ORG_DID / T3N_AGENT_DID missing. Run \`npm run t3n:setup\` first.`);
    process.exit(1);
  }

  setEnvironment(envName);
  applyBaseUrlOverride();
  const wasmComponent = await loadWasmComponent();
  const address = eth_get_address(tenantKey);
  const t3n = new T3nClient({
    trustAnchor: await fetchTrustedManifest(envName),
    wasmComponent,
    handlers: { EthSign: metamask_sign(address, undefined, tenantKey) },
  });
  await t3n.handshake();
  const tenantDid = (await t3n.authenticate(createEthAuthInput(address))).value;
  ok(`authenticated as ${tenantDid}`);
  info(`organisation: ${orgDid}`);
  info(`agent:        ${agentDid}`);

  const org = createOrgDataClientFromSession(t3n, getNodeUrl());

  // --- 1. writers (ACLs default to deny) ---------------------------------
  console.log(`\n${BOLD}1. Declaring scope writers${RESET}`);
  // `setWriters` replaces a scope's whole writer list, so passing only the
  // tenant removed any other writer the organisation had declared — another
  // service, a second admin, an issuer writing its own claims. Read, union,
  // write back; and as with the grant record, a failed READ must stop the
  // write rather than be treated as "there were no other writers".
  for (const scope of ALL_SCOPES) {
    let existingWriters: string[];
    try {
      existingWriters = (await org.writersGet({ orgDid, scope })).writers;
    } catch (err) {
      fail(`could not read the writer list for ${scope}: ${err instanceof Error ? err.message : String(err)}`);
      info("Refusing to continue: setWriters replaces the whole list, so writing without");
      info("knowing the current one would remove every other writer on this scope.");
      process.exit(1);
    }

    const already = existingWriters.some((w) => w.toLowerCase() === tenantDid.toLowerCase());
    if (already && existingWriters.length > 0) {
      info(`writer already set on ${scope} (${existingWriters.length} total)`);
      continue;
    }
    const merged = [...existingWriters, tenantDid];
    try {
      await org.setWriters({ orgDid, scope, writers: merged });
      const kept = merged.length - 1;
      info(`writer set on ${scope}${kept > 0 ? ` (${kept} existing writer(s) preserved)` : ""}`);
    } catch (err) {
      warn(`setWriters failed on ${scope}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  ok("scope writers declared");

  // --- 2. claim records ---------------------------------------------------
  console.log(`\n${BOLD}2. Writing minimized claim records${RESET}`);
  // The contract derives each entry id from this counter, so a re-run addresses
  // the same entries rather than appending duplicates. It does NOT overwrite
  // them: the contract rejects the second write with `DerivedEntryIdCollision`,
  // which is treated as "already present" below. Re-running is therefore safe
  // and idempotent, but it will not push edited claim values — to change a
  // seeded record, delete the entry first. The comment here used to claim a
  // re-run "updates", which sent anyone editing RECORDS down a dead end.
  let seq = 1000;
  const failedWrites: string[] = [];
  for (const r of RECORDS) {
    const payload = {
      v: 1 as const,
      subject: tenantDid,
      claim: r.claim,
      verified: r.verified,
      assurance: r.assurance,
      verifiedAt: r.verifiedAt,
      expiresAt: r.expiresAt,
      issuerCategory: r.issuerCategory,
      evidenceRef: `vc:sha256:${r.claim}`,
    };
    const payloadHex = Buffer.from(JSON.stringify(payload), "utf8").toString("hex");
    try {
      const res = await org.writeData({ orgDid, scope: r.scope, payloadHex, clientSeqNo: seq++ });
      info(`${r.claim} → ${r.scope} (entry ${res.entry_id})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("DerivedEntryIdCollision")) {
        info(`${r.claim} → ${r.scope} (already present)`);
      } else {
        warn(`write failed for ${r.claim}: ${message}`);
        failedWrites.push(`${r.claim} → ${r.scope}`);
      }
    }
  }
  // Every failure above was a `warn` inside the loop, and the script then
  // printed a green tick claiming all of them had been written and exited 0.
  // A seed where every write failed reported complete success, and the operator
  // only discovered it when live evaluation found no claims.
  if (failedWrites.length > 0) {
    fail(`${failedWrites.length} of ${RECORDS.length} claim records could not be written`);
    for (const f of failedWrites) info(`  failed: ${f}`);
    info("Fix the cause and re-run. Grants are not recorded against a partial seed.");
    process.exit(1);
  }
  ok(`${RECORDS.length} claim records written`);
  info("no names, documents, dates of birth or identifiers were written");

  // --- 3. org grants ------------------------------------------------------
  console.log(`\n${BOLD}3. Granting the agent read access${RESET}`);
  // `setGrants` is a full-document write: the list passed in becomes the entire
  // grant record. Sending only this agent's row therefore *revokes* every other
  // grantee on the contract — so re-running the seed against an org that has
  // other agents, or a second agent provisioned later, silently deletes access
  // nobody asked to remove. Read first, replace only our own row, write back the
  // whole merged list.
  //
  // The read must SUCCEED before the write. `grantsGet` returns an empty list
  // when no grant record exists (verified against testnet: an unknown contract
  // id returns `{grants: []}` rather than throwing), so a thrown error here can
  // only mean a real failure — a network blip, a 5xx, an expired session. This
  // catch previously swallowed that and carried on with an empty `existing`,
  // which turned a transient read failure into a full-document write that
  // revoked every other grantee. Refusing to write is the only safe response.
  let existingGrants: UserGrant[];
  try {
    existingGrants = (await org.grantsGet({ orgDid, contractId })).grants;
  } catch (err) {
    fail(`could not read the existing grant record: ${err instanceof Error ? err.message : String(err)}`);
    info("Refusing to continue: `setGrants` replaces the whole document, so writing");
    info("without knowing what is already there would revoke every other grantee.");
    process.exit(1);
  }
  const preservedGrants = existingGrants.filter(
    (g) => g.user_did.toLowerCase() !== agentDid.toLowerCase(),
  );
  for (const g of preservedGrants) info(`preserved grant: ${g.user_did}`);
  await org.setGrants({
    orgDid,
    contractId,
    grants: [
      ...preservedGrants,
      { user_did: agentDid, functions: READ_FUNCTIONS, scopes: GRANTED_SCOPES },
    ],
  });
  ok(`agent granted ${GRANTED_SCOPES.length} scopes`);
  info(`granted:     ${GRANTED_SCOPES.join(", ")}`);
  info(`NOT granted: compliance/training, compliance/background`);
  info("that omission is deliberate — it is what makes a live REVIEW_REQUIRED demonstrable");

  // --- 4. member delegation (signed by the data owner) --------------------
  console.log(`\n${BOLD}4. Recording the data owner's delegation${RESET}`);
  // Same full-document hazard as `setGrants` above: `agentAuthUpdate` replaces
  // the owner's entire delegation policy, so a bare single-agent write revokes
  // every other agent the data owner has authorised. `mergeAgentAuthEntries`
  // leaves other agents (and other scripts on this agent) untouched and replaces
  // only the row for this contract.
  const ourEntry: AgentAuthEntry = {
    agentDid,
    scripts: [
      {
        scriptName: contractId,
        versionReq: null,
        functions: READ_FUNCTIONS,
        scopes: GRANTED_SCOPES,
        readScopes: GRANTED_SCOPES,
        allowedHosts: [],
      },
    ],
  };
  // Same rule as the grant record above: `agentAuthUpdate` replaces the whole
  // delegation policy, so a failed read must stop the write rather than be
  // treated as "there was nothing there".
  let existingAgents: AgentAuthEntry[];
  let existingDiscoverDids: string[];
  try {
    const current = await t3n.getAgentAuth();
    existingAgents = current.agents;
    existingDiscoverDids = current.discoverDids;
  } catch (err) {
    fail(`could not read the existing delegation policy: ${err instanceof Error ? err.message : String(err)}`);
    info("Refusing to continue rather than revoking every other delegated agent.");
    process.exit(1);
  }
  const mergedAuth = mergeAgentAuthEntries(existingAgents, [ourEntry]);
  for (const row of mergedAuth.preservedRows) info(`preserved delegation: ${row}`);
  // The document also carries `discoverDids`, the DIDs the data owner lets
  // their agents discover. An omitted or empty list persists as empty, so
  // writing only `agents` silently wiped it on every run.
  if (existingDiscoverDids.length > 0) {
    info(`preserved ${existingDiscoverDids.length} document-level discovery grant(s)`);
  }
  await t3n.agentAuthUpdate({ agents: mergedAuth.agents, discoverDids: existingDiscoverDids });
  ok("agent-auth delegation recorded on-network");

  const policy = await t3n.getAgentAuth();
  const entry = policy.agents.find((a) => a.agentDid === agentDid);
  const script = entry?.scripts[0];
  if (script?.validUntilSecs) {
    info(`grant valid until ${new Date(script.validUntilSecs * 1000).toISOString()}`);
  }

  console.log(`\n${GREEN}${BOLD}Seed complete.${RESET}`);
  console.log(`${DIM}Live subject DID: ${tenantDid}${RESET}`);
  console.log(`${DIM}Set CLAIM_SOURCE=live in .env and restart to evaluate against it.${RESET}\n`);
}

main().catch((err: unknown) => {
  console.error(`\n${RED}Seeding failed.${RESET}`);
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  process.exit(1);
});
