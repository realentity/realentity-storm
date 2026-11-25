import { nodeConfig } from "@realentity/storm-config/eslint/base.mjs";

export default [
  ...nodeConfig(import.meta.dirname),
  {
    // docs/design.md §7: the api only encrypts. Decrypting and re-wrapping happen in the worker. (Tests may open to verify.)
    // M64: the api holds SealKeys (public keys, the integration and field-hash keys), never the root keys (KeyRing).
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@realentity/storm-crypto",
              importNames: ["KeyRing", "open", "rewrap", "rewrapSymmetric", "sealSymmetric", "openField", "rewrapField", "rewrapIntegration"],
              message: "The api seals with SealKeys and opens only integrations (openIntegration); the root keys, opening and rotating are the worker's (docs/design.md §7).",
            },
          ],
        },
      ],
    },
  },
  {
    // CLI scripts (pnpm auth:setup, pnpm eval:builder) talk to the terminal.
    files: ["src/tools/**/*.ts", "evals/**/*.ts"],
    rules: { "no-console": "off" },
  },
];
