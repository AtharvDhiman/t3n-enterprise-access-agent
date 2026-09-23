# Enterprise Access & Compliance Tenant Contract (v2.0.0)

WASM tenant contract for Terminal 3 Network (T3N), updated for the **per-function grant scoping** host upgrade (`host:tenant@2.0.0`).

---

## What Changed in v2.0.0

1. **MAJOR Version Bump**: `CONTRACT_VERSION = "2.0.0"` per breaking host upgrade requirements.
2. **Per-Function Grant Scoping**:
   - `host::delegated_functions()` now returns a single function `String` (or `"*"` for all functions).
   - Tenant contract grants are keyed per function, preventing an agent authorized for evaluation from accessing scopes reserved for other contract functions.
3. **Structured Scope Records**:
   - `host::delegated_scopes()` now returns `list<scope>` records with `{ path: string, access: list<access-verb> }`.
   - The contract verifies `.access` contains `read` before authorizing data reads.
4. **Retired Roster Split**:
   - `delegated-read-scopes()` accessor has been completely removed. Differential access is now expressed via function targeting.

---

## Building the WASM Target

Prerequisites:
- [Rust](https://rustup.rs/) (1.75+)
- WebAssembly WASI target: `rustup target add wasm32-wasip1`
- `cargo-component`: `cargo install cargo-component`

Build command:
```bash
cd contracts/enterprise-access-contract
cargo component build --release --target wasm32-wasip1
```

The compiled WASM component will be generated at:
`target/wasm32-wasip1/release/enterprise_access_contract.wasm`

---

## Deploying to Terminal 3

Using the T3N CLI or developer portal:

```bash
# Upload new WASM to your existing tenant contract slot
t3n contract upload \
  --contract-id "z:access-agent/contracts" \
  --version "2.0.0" \
  --wasm target/wasm32-wasip1/release/enterprise_access_contract.wasm
```

Rebuilding and re-uploading ensures the contract instantiates successfully against the new node host build.
