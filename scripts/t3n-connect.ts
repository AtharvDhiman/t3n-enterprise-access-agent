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

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
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
  const agentKey = requireKey("T3N_AGENT_KEY");

  if (tenantKey.toLowerCase() === agentKey.toLowerCase()) {
    fail(
      "T3N_AGENT_KEY is the same as T3N_API_KEY. The agent needs its own identity and its own credits — claim a second key.",
    );
    process.exit(1);
  }
  ok("keys present, well-formed, and distinct");

  setEnvironment(envName);
  ok(`environment set to "${envName}"`);
  info(`node URL: ${getNodeUrl()}`);

  const t0 = Date.now();
  const wasmComponent = await loadWasmComponent();
  ok(`WASM component loaded (${Date.now() - t0} ms)`);

  const tenantDid = await authenticateAs("tenant", tenantKey, envName, wasmComponent);
  const agentDid = await authenticateAs("agent", agentKey, envName, wasmComponent);

  if (tenantDid === agentDid) {
    fail("tenant and agent resolved to the SAME DID — they must be separate identities.");
    process.exit(1);
  }
  ok("tenant and agent are distinct DIDs");

  // Keyed, session-free read. Confirms the agent's API key works on the
  // `discover` transport the delegation check also uses.
  try {
    const who = await discoverWhoami({ baseUrl: getNodeUrl(), apiKey: agentKey });
    ok(`discoverWhoami: ${who.did}`);
    info(`organisations: ${who.organisations.length > 0 ? who.organisations.join(", ") : "(none)"}`);
    info(`owner: ${who.owner ?? "(none)"}`);
  } catch (err) {
    fail(`discoverWhoami failed: ${err instanceof Error ? err.message : String(err)}`);
    info("The session auth above still succeeded; this affects the keyed transport only.");
  }

  console.log(`\n${GREEN}${BOLD}Connection verified.${RESET}`);
  console.log(`${DIM}Tenant DID: ${tenantDid}${RESET}`);
  console.log(`${DIM}Agent  DID: ${agentDid}${RESET}\n`);
}

main().catch((err: unknown) => {
  console.error(`\n${RED}Connection check failed.${RESET}`);
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  if (err instanceof Error && err.cause) console.error("cause:", err.cause);
  process.exit(1);
});
