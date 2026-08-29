/**
 * One-time Terminal 3 provisioning.
 *
 * Creates the two pieces of on-network state this project needs:
 *
 *   1. an **organisation** owned by the tenant — the container compliance
 *      scopes and grants are keyed under; and
 *   2. an **agent identity** with its own DID and its own opaque API key.
 *
 * Why an agent must be provisioned rather than claimed: revisiting the claim
 * page mints a fresh *private key*, but the network binds every key you claim
 * while signed in to the **same account**, so both keys resolve to the same
 * DID. A genuinely separate agent identity comes from `createAgent`, which
 * mints a new DID under the organisation and returns a one-time opaque
 * `t3n_key_…` — the credential the keyed transports (`invoke`,
 * `discoverCheckDelegation`) actually accept.
 *
 * The agent's API key is returned **exactly once** and is never recoverable, so
 * this script writes it straight into `.env` rather than printing it.
 *
 * Idempotent: reuses an existing organisation, and refuses to mint a second
 * agent if one is already recorded in `.env`.
 *
 * Run:  npm run t3n:setup
 */

import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  T3nClient,
  setEnvironment,
  loadWasmComponent,
  eth_get_address,
  metamask_sign,
  createEthAuthInput,
  fetchTrustedManifest,
  formatTokens,
  type Environment,
} from "@terminal3/t3n-sdk";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const ok = (m: string) => console.log(`${GREEN}✓${RESET} ${m}`);
const warn = (m: string) => console.log(`${YELLOW}!${RESET} ${m}`);
const info = (m: string) => console.log(`${DIM}  ${m}${RESET}`);

const ENV_PATH = resolve(process.cwd(), ".env");
const ORG_NAME = process.env.T3N_ORG_NAME?.trim() || "Access & Compliance Demo Org";
const AGENT_NAME = process.env.T3N_AGENT_NAME?.trim() || "access-compliance-agent";

/** Upsert `KEY=value` in `.env`, preserving everything else verbatim. */
async function setEnvVar(key: string, value: string): Promise<void> {
  let text = existsSync(ENV_PATH) ? await readFile(ENV_PATH, "utf8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(text)) {
    text = text.replace(re, line);
  } else {
    if (text.length > 0 && !text.endsWith("\n")) text += "\n";
    text += `${line}\n`;
  }
  await writeFile(ENV_PATH, text, "utf8");
}

async function main(): Promise<void> {
  console.log(`\n${BOLD}Terminal 3 provisioning${RESET}\n`);

  const envName = (process.env.T3N_ENV?.trim() || "testnet") as Environment;
  const tenantKey = process.env.T3N_API_KEY?.trim();
  if (!tenantKey || !/^0x[0-9a-fA-F]{64}$/.test(tenantKey) || /^0x0{64}$/.test(tenantKey)) {
    console.error(`${RED}✗${RESET} T3N_API_KEY is missing or not a valid key. See .env.example.`);
    process.exit(1);
  }

  setEnvironment(envName);
  const wasmComponent = await loadWasmComponent();
  const address = eth_get_address(tenantKey);

  const t3n = new T3nClient({
    trustAnchor: await fetchTrustedManifest(envName),
    wasmComponent,
    handlers: { EthSign: metamask_sign(address, undefined, tenantKey) },
  });

  await t3n.handshake();
  const tenantDid = (await t3n.authenticate(createEthAuthInput(address))).value;
  ok(`tenant authenticated: ${tenantDid}`);

  const balance = await t3n.getBalance();
  info(`credit balance: ${formatTokens(BigInt(balance.available))}`);
  if (balance.available === 0) {
    warn("balance is zero — provisioning writes will fail. Claim credits first.");
  }

  // --- organisation ------------------------------------------------------
  let orgDid = process.env.T3N_ORG_DID?.trim() || "";
  if (orgDid) {
    ok(`reusing organisation from .env: ${orgDid}`);
  } else {
    const existing = await t3n.myOrgs();
    if (existing.length > 0 && existing[0]) {
      orgDid = existing[0].value;
      ok(`reusing existing organisation: ${orgDid}`);
    } else {
      info(`creating organisation "${ORG_NAME}"…`);
      const created = await t3n.createOrganisation(ORG_NAME);
      orgDid = created.value;
      ok(`organisation created: ${orgDid}`);
    }
    await setEnvVar("T3N_ORG_DID", orgDid);
    info("wrote T3N_ORG_DID to .env");
  }

  // --- agent -------------------------------------------------------------
  const existingAgentKey = process.env.T3N_AGENT_API_KEY?.trim();
  if (existingAgentKey && existingAgentKey.length > 0) {
    warn("T3N_AGENT_API_KEY is already set — not minting a second agent.");
    info(`existing agent DID: ${process.env.T3N_AGENT_DID ?? "(unknown)"}`);
    info("To provision a fresh agent, clear T3N_AGENT_API_KEY and T3N_AGENT_DID from .env and re-run.");
  } else {
    info(`creating agent "${AGENT_NAME}" under the organisation…`);
    const agent = await t3n.createAgent(orgDid, AGENT_NAME);
    const agentDid = agent.agentDid.value;

    // Returned exactly once and never recoverable — persist before anything
    // else can fail.
    await setEnvVar("T3N_AGENT_API_KEY", agent.apiKey);
    await setEnvVar("T3N_AGENT_DID", agentDid);
    await setEnvVar("T3N_AGENT_KEY_ID", agent.keyId);

    ok(`agent created: ${agentDid}`);
    info(`key id: ${agent.keyId}`);
    info("agent API key written to .env as T3N_AGENT_API_KEY (shown once, never printed here)");
    if (agent.cardEntryId) info(`private agent card hosted: entry ${agent.cardEntryId}`);

    if (agentDid === tenantDid) {
      console.error(`${RED}✗${RESET} agent DID equals tenant DID — provisioning did not create a separate identity.`);
      process.exit(1);
    }
    ok("agent identity is distinct from the tenant identity");
  }

  console.log(`\n${GREEN}${BOLD}Provisioning complete.${RESET}`);
  console.log(`${DIM}Organisation : ${orgDid}${RESET}`);
  console.log(`${DIM}Next         : npm run t3n:grant   (seed claims + record consent)${RESET}\n`);
}

main().catch((err: unknown) => {
  console.error(`\n${RED}Provisioning failed.${RESET}`);
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  if (err instanceof Error && err.cause) console.error("cause:", err.cause);
  process.exit(1);
});
