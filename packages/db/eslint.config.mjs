import { nodeConfig } from "@realentity/storm-config/eslint/base.mjs";

export default [
  ...nodeConfig(import.meta.dirname),
  {
    files: ["prisma/**/*.ts", "prisma.config.ts"],
    languageOptions: { parserOptions: { projectService: false, project: "./tsconfig.tools.json", tsconfigRootDir: import.meta.dirname } },
    rules: { "no-console": "off" },
  },
];
