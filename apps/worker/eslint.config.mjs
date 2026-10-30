import { nodeConfig } from "@ai-me/config/eslint/base.mjs";

export default [
  ...nodeConfig(import.meta.dirname),
  {
    // CLI scripts (pnpm auth:setup, pnpm keys:rotate) talk to the terminal.
    files: ["src/tools/**/*.ts"],
    rules: { "no-console": "off" },
  },
];
