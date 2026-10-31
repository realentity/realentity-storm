import { nodeConfig } from "@ai-me/config/eslint/base.mjs";

export default [
  ...nodeConfig(import.meta.dirname),
  {
    // CLI scripts (pnpm keys:rotate, pnpm eval:email) talk to the terminal.
    files: ["src/tools/**/*.ts", "evals/**/*.ts"],
    rules: { "no-console": "off" },
  },
];
