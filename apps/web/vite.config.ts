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
    proxy: {
      "/api": {
        target: process.env.API_URL || "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
