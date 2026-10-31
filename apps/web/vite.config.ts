import react from "@vitejs/plugin-react";
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { defineConfig } from "vite";

/**
 * The dev server proxies /api to the api (API_HOST/API_PORT from the environment, else the root .env), so the session
 * cookie is same-origin. The browser tests (apps/web-e2e) point it at their own api this way.
 */
export default defineConfig(({ mode }) => {
  const rootEnv: Record<string, string> = {};
  loadDotenv({ path: resolve(__dirname, "../../.env"), processEnv: rootEnv, quiet: true });
  const host = process.env.API_HOST || rootEnv.API_HOST || "127.0.0.1";
  const api = `http://${host}:${process.env.API_PORT || rootEnv.API_PORT || 3000}`;

  return {
    plugins: [react()],
    // ws: the live events socket (/api/events). The Host header is kept, so the api's same-origin check passes.
    server: { host: "127.0.0.1", port: 5173, strictPort: true, proxy: { "/api": { target: api, ws: true } } },
    build: { sourcemap: mode !== "production" },
  };
});
