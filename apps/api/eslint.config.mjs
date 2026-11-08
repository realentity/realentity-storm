import { nodeConfig } from "@realentity/storm-config/eslint/base.mjs";

export default [
  ...nodeConfig(import.meta.dirname),
  {
    // README §7: the api only encrypts. Decrypting and re-wrapping happen in the worker. (Tests may open to verify.)
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [{ name: "@realentity/storm-crypto", importNames: ["open", "rewrap"], message: "Only the worker decrypts credentials (README §7)." }] },
      ],
    },
  },
  {
    // CLI scripts (pnpm auth:setup, pnpm eval:builder) talk to the terminal.
    files: ["src/tools/**/*.ts", "evals/**/*.ts"],
    rules: { "no-console": "off" },
  },
];
