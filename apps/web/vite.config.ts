import react from "@vitejs/plugin-react";
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { defineConfig } from "vite";

/** The dev server proxies /api to the api (API_HOST/API_PORT from the root .env), so the session cookie is same-origin. */
export default defineConfig(({ mode }) => {
  const rootEnv: Record<string, string> = {};
  loadDotenv({ path: resolve(__dirname, "../../.env"), processEnv: rootEnv, quiet: true });
  const api = `http://${rootEnv.API_HOST || "127.0.0.1"}:${rootEnv.API_PORT || 3000}`;

  return {
    plugins: [react()],
    server: { host: "127.0.0.1", port: 5173, strictPort: true, proxy: { "/api": api } },
    build: { sourcemap: mode !== "production" },
  };
});
