/**
 * Phase 1 connectivity check.
 *
 * Deliberately written against the SDK directly, following the documented
 * quickstart pattern verbatim rather than going through this project's own
 * adapter. When something breaks, that separation answers the first debugging
 * question for free: is it Terminal 3, or is it us?
 *
 * Run:  npm run t3n:connect
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
  discoverWhoami,
  type Environment,
} from "@terminal3/t3n-sdk";

import { applyBaseUrlOverride } from "./lib/node-url.ts";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function ok(msg: string): void {
  console.log(`${GREEN}✓${RESET} ${msg}`);
}
function fail(msg: string): void {
  console.log(`${RED}✗${RESET} ${msg}`);
}
function info(msg: string): void {
  console.log(`${DIM}  ${msg}${RESET}`);
}

/** Mask key material so a terminal screenshot is never a leak. */
function mask(key: string): string {
  return key.length > 12 ? `${key.slice(0, 6)}…${key.slice(-4)}` : "[REDACTED]";
}

function warn(msg: string): void {
  console.log(`${YELLOW}!${RESET} ${msg}`);
}

function requireKey(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    fail(`${name} is not set. Add it to .env (see .env.example).`);
    process.exit(1);
  }
  if (/^0x0{64}$/.test(value)) {
    fail(`${name} is still the placeholder. Paste a real key from https://www.terminal3.io/claim-page`);
    process.exit(1);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    fail(`${name} is not a valid secp256k1 key (expected 0x + 64 hex chars).`);
    process.exit(1);
  }
  return value;
}

async function authenticateAs(
  role: string,
  privateKey: string,
  env: Environment,
  wasmComponent: Awaited<ReturnType<typeof loadWasmComponent>>,
): Promise<string> {
  const address = eth_get_address(privateKey);
  info(`${role}: key ${mask(privateKey)} → address ${address.slice(0, 10)}…`);

  const client = new T3nClient({
    trustAnchor: await fetchTrustedManifest(env),
    wasmComponent,
    handlers: { EthSign: metamask_sign(address, undefined, privateKey) },
  });

  await client.handshake();
  info(`${role}: handshake complete`);

  const did = await client.authenticate(createEthAuthInput(address));
  ok(`${role} authenticated as ${BOLD}${did.value}${RESET}`);
  return did.value;
}

async function main(): Promise<void> {
  console.log(`\n${BOLD}Terminal 3 connectivity check${RESET}\n`);

  const envName = (process.env.T3N_ENV?.trim() || "testnet") as Environment;
  const tenantKey = requireKey("T3N_API_KEY");

  // T3N_AGENT_KEY is optional — `.env.example` ships it blank and the README
  // tells a new user to run this script FIRST, before `t3n:setup` has
  // provisioned anything. Requiring it made the documented onboarding path fail
  // at step one with a message about a variable the docs call optional.
  const agentKeyRaw = process.env.T3N_AGENT_KEY?.trim() ?? "";
  const agentKey =
    agentKeyRaw && agentKeyRaw !== `0x${"0".repeat(64)}` ? agentKeyRaw : null;

  if (agentKey && !/^0x[0-9a-fA-F]{64}$/.test(agentKey)) {
    fail("T3N_AGENT_KEY is set but is not a valid secp256k1 key (expected 0x + 64 hex chars).");
    process.exit(1);
  }
  if (agentKey && tenantKey.toLowerCase() === agentKey.toLowerCase()) {
    fail(
      "T3N_AGENT_KEY is the same as T3N_API_KEY. The agent needs its own identity and its own credits — claim a second key.",
    );
    process.exit(1);
  }
  ok(agentKey ? "keys present, well-formed, and distinct" : "tenant key present and well-formed");
  if (!agentKey) {
    info("T3N_AGENT_KEY not set — checking the tenant only. That is the expected first run.");
  }

  setEnvironment(envName);
  // The server honours T3N_BASE_URL (packages/t3n/src/config.ts) but the CLIs
  // did not, so an operator pointing the app at a specific node still had these
  // scripts talking to the environment default — seeding one node while the app
  // read another, with no error to explain the empty results.
  applyBaseUrlOverride();
  ok(`environment set to "${envName}"`);
  info(`node URL: ${getNodeUrl()}`);

  const t0 = Date.now();
  const wasmComponent = await loadWasmComponent();
  ok(`WASM component loaded (${Date.now() - t0} ms)`);

  const tenantDid = await authenticateAs("tenant", tenantKey, envName, wasmComponent);

  let agentDid: string | null = null;
  if (agentKey) {
    agentDid = await authenticateAs("agent", agentKey, envName, wasmComponent);
    if (tenantDid === agentDid) {
      // A warning, not a fatal error. Every key claimed under one Terminal 3
      // account binds to that account's single identity, so a second claimed
      // key resolving to the tenant DID is the NORMAL outcome — and the server
      // handles it: it ignores T3N_AGENT_KEY and runs in DELEGATED_TENANT_READ
      // using the `createAgent`-provisioned agent and its opaque credential.
      // Exiting 1 here made the documented first command fail on a deployment
      // that works, and told the operator to run `t3n:setup`, which they had
      // already run — the agent identity exists, it just has no session key.
      warn(
        "T3N_AGENT_KEY resolves to the same DID as T3N_API_KEY. Both keys were claimed under one account, so they bind to one identity.",
      );
      info("This is not fatal. The server ignores T3N_AGENT_KEY and uses the");
      info("provisioned agent's opaque credential instead (DELEGATED_TENANT_READ).");
      agentDid = null;
    } else {
      ok("tenant and agent are distinct DIDs");
    }
  }

  // Keyed, session-free read. Confirms the agent's API key works on the
  // `discover` transport the delegation check also uses.
  // The discover transport takes the OPAQUE `t3n_key_…` credential, relayed
  // verbatim in an X-T3N-Api-Key header. This previously passed the raw
  // secp256k1 private key instead — a credential-handling defect regardless of
  // whether the call succeeded, since a private key has no business travelling
  // in an HTTP header where an intermediary could log it.
  const agentApiKey = process.env.T3N_AGENT_API_KEY?.trim() ?? "";
  if (!agentApiKey) {
    info("T3N_AGENT_API_KEY not set — skipping the keyed transport check.");
    info("Run `npm run t3n:setup` to provision an agent identity and its credential.");
  } else if (!/^t3n_key_/.test(agentApiKey)) {
    fail("T3N_AGENT_API_KEY is not an opaque t3n_key_… credential; refusing to send it.");
  } else {
    try {
      const who = await discoverWhoami({ baseUrl: getNodeUrl(), apiKey: agentApiKey });
      ok(`discoverWhoami: ${who.did}`);
      info(
        `organisations: ${who.organisations.length > 0 ? who.organisations.join(", ") : "(none)"}`,
      );
      info(`owner: ${who.owner ?? "(none)"}`);
    } catch (err) {
      fail(`discoverWhoami failed: ${err instanceof Error ? err.message : String(err)}`);
      info("The session auth above still succeeded; this affects the keyed transport only.");
    }
  }

  console.log(`\n${GREEN}${BOLD}Connection verified.${RESET}`);
  console.log(`${DIM}Tenant DID: ${tenantDid}${RESET}`);
  if (agentDid) console.log(`${DIM}Agent  DID: ${agentDid}${RESET}`);
  console.log("");
}

main().catch((err: unknown) => {
  console.error(`\n${RED}Connection check failed.${RESET}`);
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  if (err instanceof Error && err.cause) console.error("cause:", err.cause);
  process.exit(1);
});
