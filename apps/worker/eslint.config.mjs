import { nodeConfig } from "@realentity/storm-config/eslint/base.mjs";

export default [
  ...nodeConfig(import.meta.dirname),
  {
    // CLI scripts (pnpm keys:rotate, pnpm eval:email) talk to the terminal.
    files: ["src/tools/**/*.ts", "evals/**/*.ts"],
    rules: { "no-console": "off" },
  },
];
