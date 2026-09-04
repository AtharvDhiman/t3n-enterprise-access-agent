import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The Terminal 3 SDK is never bundled here.
 *
 * It loads a WASM component that breaks under Vite (an officially acknowledged
 * rough edge), and it needs credentials that must never reach a browser. The
 * frontend therefore talks only to the Node API over HTTP; `@t3n-aca/t3n` is
 * not a dependency of this workspace and importing it would fail to resolve —
 * which is the intended guard rail, not an inconvenience.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In a Codespace the dev server has to bind every interface and accept the
    // forwarded *.app.github.dev hostname, or the port forwarder reaches a
    // server listening only on 127.0.0.1 and Vite rejects the Host header as
    // unrecognised. Both are gated on the CODESPACES variable so a local run is
    // unchanged and the dev server is not exposed on the LAN.
    ...(process.env.CODESPACES
      ? { host: true as const, allowedHosts: [".app.github.dev"] }
      : {}),
    proxy: {
      "/api": {
        target: process.env.API_URL || "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
